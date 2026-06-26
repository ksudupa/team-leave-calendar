const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const Pusher = require('pusher');
const ical = require('node-ical');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const pusher = process.env.PUSHER_APP_ID
  ? new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS: true
    })
  : null;

function notifyChange() {
  if (!pusher) return;
  pusher.trigger('team-calendar', 'update', {}).catch(err => console.error('Pusher trigger failed:', err));
}

const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#43aa8b', '#f3722c', '#577590', '#ff6b6b', '#118ab2'];
const TEAM = ['Jasmine', 'Esri', 'Godwin', 'Richardo', 'Kaushal'];

let initPromise = null;
function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS members (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leaves (
          id SERIAL PRIMARY KEY,
          member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'Leave',
          half_day TEXT,
          start_time TEXT,
          end_time TEXT,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          due_date TEXT,
          status TEXT NOT NULL DEFAULT 'Pending Acceptance',
          note TEXT,
          reviewer_id INTEGER REFERENCES members(id)
        );
        CREATE TABLE IF NOT EXISTS canvas_events (
          uid TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          start_date TEXT NOT NULL,
          start_time TEXT,
          all_day BOOLEAN NOT NULL DEFAULT false,
          url TEXT
        );
        CREATE TABLE IF NOT EXISTS canvas_sync (
          id INTEGER PRIMARY KEY DEFAULT 1,
          last_synced_at TIMESTAMPTZ
        );
      `);

      await pool.query(`
        ALTER TABLE leaves ADD COLUMN IF NOT EXISTS start_time TEXT;
        ALTER TABLE leaves ADD COLUMN IF NOT EXISTS end_time TEXT;
        ALTER TABLE canvas_events ADD COLUMN IF NOT EXISTS start_time TEXT;
      `);

      for (const name of TEAM) {
        const { rows } = await pool.query('SELECT 1 FROM members WHERE name = $1', [name]);
        if (rows.length === 0) {
          const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM members');
          const color = COLORS[Number(countRows[0].c) % COLORS.length];
          await pool.query('INSERT INTO members (name, color) VALUES ($1, $2)', [name, color]);
        }
      }
    })();
  }
  return initPromise;
}

async function getOrCreateMember(name) {
  let { rows } = await pool.query('SELECT * FROM members WHERE name = $1', [name]);
  if (rows.length > 0) return rows[0];
  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM members');
  const color = COLORS[Number(countRows[0].c) % COLORS.length];
  const { rows: inserted } = await pool.query(
    'INSERT INTO members (name, color) VALUES ($1, $2) RETURNING *',
    [name, color]
  );
  return inserted[0];
}

const CANVAS_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CANVAS_START_DATE = '2026-06-22';
const CANVAS_CUTOFF_DATE = '2026-07-17';

async function syncCanvasEventsIfStale() {
  if (!process.env.CANVAS_ICS_URL) return;

  const { rows } = await pool.query('SELECT last_synced_at FROM canvas_sync WHERE id = 1');
  const lastSynced = rows[0]?.last_synced_at;
  if (lastSynced && Date.now() - new Date(lastSynced).getTime() < CANVAS_SYNC_INTERVAL_MS) {
    return;
  }

  try {
    const res = await fetch(process.env.CANVAS_ICS_URL);
    const text = await res.text();
    const parsed = ical.sync.parseICS(text);

    for (const key in parsed) {
      const event = parsed[key];
      if (event.type !== 'VEVENT' || !event.start) continue;
      const allDay = event.datetype === 'date';
      const d = event.start;
      const startDate = allDay
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      const startTime = allDay
        ? null
        : new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
      const eventUrl = typeof event.url === 'string' ? event.url : (event.url?.val || null);
      if (startDate > CANVAS_CUTOFF_DATE || startDate < CANVAS_START_DATE) continue;
      await pool.query(`
        INSERT INTO canvas_events (uid, title, start_date, start_time, all_day, url)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (uid) DO UPDATE SET title = $2, start_date = $3, start_time = $4, all_day = $5, url = $6
      `, [event.uid || key, event.summary || 'Canvas event', startDate, startTime, allDay, eventUrl]);
    }

    await pool.query(`
      INSERT INTO canvas_sync (id, last_synced_at) VALUES (1, now())
      ON CONFLICT (id) DO UPDATE SET last_synced_at = now()
    `);
  } catch (err) {
    console.error('Canvas sync failed:', err);
  }
}

async function findLeaveConflict(memberId, dueDate) {
  if (!dueDate) return null;
  const { rows } = await pool.query(
    'SELECT * FROM leaves WHERE member_id = $1 AND $2 BETWEEN start_date AND end_date',
    [memberId, dueDate]
  );
  return rows[0] || null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req, res, next) => {
  try {
    await initDb();
    next();
  } catch (err) {
    next(err);
  }
});

function wrapAsync(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

app.get('/api/canvas-events', wrapAsync(async (req, res) => {
  await syncCanvasEventsIfStale();
  const { rows } = await pool.query(`
    SELECT * FROM canvas_events
    WHERE start_date >= $1 AND start_date <= $2
    ORDER BY start_date, (start_time IS NULL), start_time
  `, [CANVAS_START_DATE, CANVAS_CUTOFF_DATE]);
  res.json(rows);
}));

app.get('/api/pusher-config', (req, res) => {
  if (!process.env.PUSHER_APP_ID) return res.json({ enabled: false });
  res.json({ enabled: true, key: process.env.PUSHER_KEY, cluster: process.env.PUSHER_CLUSTER });
});

app.get('/api/members', wrapAsync(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM members ORDER BY name');
  res.json(rows);
}));

app.get('/api/leaves', wrapAsync(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT leaves.*, members.name AS member_name, members.color AS member_color
    FROM leaves JOIN members ON leaves.member_id = members.id
    ORDER BY start_date
  `);
  res.json(rows);
}));

app.post('/api/leaves', wrapAsync(async (req, res) => {
  const { name, start_date, end_date, type, note, half_day, start_time, end_time } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, end_date are required' });
  }
  if ((half_day || (start_time && end_time)) && start_date !== end_date) {
    return res.status(400).json({ error: 'half-day and hourly entries must have start_date === end_date' });
  }
  if (half_day && start_time && end_time) {
    return res.status(400).json({ error: 'Choose either half-day or hourly, not both' });
  }
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return res.status(400).json({ error: 'Both start_time and end_time are required for hourly leave' });
  }
  if (start_time && end_time && end_time <= start_time) {
    return res.status(400).json({ error: 'end_time must be after start_time' });
  }
  const member = await getOrCreateMember(name.trim());

  const { rows: conflicts } = await pool.query(`
    SELECT * FROM tasks
    WHERE member_id = $1 AND status != 'Done'
      AND due_date IS NOT NULL AND due_date BETWEEN $2 AND $3
  `, [member.id, start_date, end_date]);

  if (conflicts.length > 0) {
    return res.status(409).json({
      error: 'You have unfinished task(s) due in this date range. Reassign or complete them before booking leave.',
      conflicts: conflicts.map(c => ({ title: c.title, due_date: c.due_date, status: c.status }))
    });
  }

  const { rows } = await pool.query(`
    INSERT INTO leaves (member_id, start_date, end_date, type, half_day, start_time, end_time, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
  `, [member.id, start_date, end_date, type || 'Leave', half_day || null, start_time || null, end_time || null, note || '']);
  notifyChange();
  res.json({ id: rows[0].id });
}));

app.patch('/api/leaves/:id', wrapAsync(async (req, res) => {
  const { start_date, end_date, type, note, half_day, start_time, end_time } = req.body;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date and end_date are required' });
  }
  if ((half_day || (start_time && end_time)) && start_date !== end_date) {
    return res.status(400).json({ error: 'half-day and hourly entries must have start_date === end_date' });
  }
  if (half_day && start_time && end_time) {
    return res.status(400).json({ error: 'Choose either half-day or hourly, not both' });
  }
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return res.status(400).json({ error: 'Both start_time and end_time are required for hourly leave' });
  }
  if (start_time && end_time && end_time <= start_time) {
    return res.status(400).json({ error: 'end_time must be after start_time' });
  }

  const { rows } = await pool.query(`
    UPDATE leaves
    SET start_date = $1, end_date = $2, type = $3, half_day = $4, start_time = $5, end_time = $6, note = $7
    WHERE id = $8 RETURNING id
  `, [start_date, end_date, type || 'Leave', half_day || null, start_time || null, end_time || null, note || '', req.params.id]);

  if (rows.length === 0) return res.status(404).json({ error: 'leave not found' });
  notifyChange();
  res.json({ ok: true });
}));

app.delete('/api/leaves/:id', wrapAsync(async (req, res) => {
  await pool.query('DELETE FROM leaves WHERE id = $1', [req.params.id]);
  notifyChange();
  res.json({ ok: true });
}));

app.get('/api/tasks', wrapAsync(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT tasks.*, members.name AS member_name, members.color AS member_color,
           reviewers.name AS reviewer_name, reviewers.color AS reviewer_color
    FROM tasks
    JOIN members ON tasks.member_id = members.id
    LEFT JOIN members AS reviewers ON tasks.reviewer_id = reviewers.id
    ORDER BY (due_date IS NULL), due_date
  `);
  res.json(rows);
}));

app.post('/api/tasks', wrapAsync(async (req, res) => {
  const { name, title, due_date, status, note } = req.body;
  if (!name || !title) {
    return res.status(400).json({ error: 'name and title are required' });
  }
  const member = await getOrCreateMember(name.trim());

  const leaveConflict = await findLeaveConflict(member.id, due_date);
  if (leaveConflict) {
    return res.status(409).json({
      error: `${name} is on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}. Pick a different due date or assignee.`
    });
  }

  const { rows } = await pool.query(`
    INSERT INTO tasks (member_id, title, due_date, status, note)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [member.id, title.trim(), due_date || null, status || 'Pending Acceptance', note || '']);
  notifyChange();
  res.json({ id: rows[0].id });
}));

app.patch('/api/tasks/:id', wrapAsync(async (req, res) => {
  const { status, name, reviewer_name, title, due_date, note } = req.body;
  if (!status && !name && !reviewer_name && !title && due_date === undefined && note === undefined) {
    return res.status(400).json({ error: 'no update fields provided' });
  }

  const { rows: taskRows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  const task = taskRows[0];
  if (!task) return res.status(404).json({ error: 'task not found' });

  if (title || due_date !== undefined || note !== undefined) {
    if (task.status === 'Done') {
      return res.status(409).json({ error: 'Completed tasks cannot be edited.' });
    }
    const newDueDate = due_date !== undefined ? due_date : task.due_date;
    const leaveConflict = await findLeaveConflict(task.member_id, newDueDate);
    if (leaveConflict) {
      return res.status(409).json({
        error: `This due date falls within an approved ${leaveConflict.type} (${leaveConflict.start_date} to ${leaveConflict.end_date}) for the assignee.`
      });
    }
    await pool.query(
      'UPDATE tasks SET title = $1, due_date = $2, note = $3 WHERE id = $4',
      [title || task.title, newDueDate || null, note !== undefined ? note : task.note, req.params.id]
    );
    notifyChange();
    return res.json({ ok: true });
  }

  if (name) {
    const member = await getOrCreateMember(name.trim());
    const leaveConflict = await findLeaveConflict(member.id, task.due_date);
    if (leaveConflict) {
      return res.status(409).json({
        error: `${name} is on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}. Pick a different assignee.`
      });
    }
    await pool.query(
      'UPDATE tasks SET member_id = $1, status = $2, reviewer_id = NULL WHERE id = $3',
      [member.id, 'Pending Acceptance', req.params.id]
    );
    notifyChange();
    return res.json({ ok: true });
  }

  if (reviewer_name) {
    const reviewer = await getOrCreateMember(reviewer_name.trim());
    await pool.query(
      'UPDATE tasks SET reviewer_id = $1, status = $2 WHERE id = $3',
      [reviewer.id, 'In Review', req.params.id]
    );
    notifyChange();
    return res.json({ ok: true });
  }

  if (status === 'Accepted' || status === 'In Progress') {
    const leaveConflict = await findLeaveConflict(task.member_id, task.due_date);
    if (leaveConflict) {
      return res.status(409).json({
        error: `You are on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}, which covers this task's due date. Reassign it or change the due date first.`
      });
    }
  }

  if (status === 'Done' && task.status !== 'In Review') {
    return res.status(409).json({
      error: 'This task must be sent for review and checked by a reviewer before it can be marked Done.'
    });
  }

  await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [status, req.params.id]);
  notifyChange();
  res.json({ ok: true });
}));

app.delete('/api/tasks/:id', wrapAsync(async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  notifyChange();
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

module.exports = { app, initDb };
