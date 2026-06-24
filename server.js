const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
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
  `);

  const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#43aa8b', '#f3722c', '#577590', '#ff6b6b', '#118ab2'];
  const TEAM = ['Jasmine', 'Esri', 'Godwin', 'Richardo', 'Kaushal'];
  for (const name of TEAM) {
    const { rows } = await pool.query('SELECT 1 FROM members WHERE name = $1', [name]);
    if (rows.length === 0) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM members');
      const color = COLORS[Number(countRows[0].c) % COLORS.length];
      await pool.query('INSERT INTO members (name, color) VALUES ($1, $2)', [name, color]);
    }
  }
}

const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#43aa8b', '#f3722c', '#577590', '#ff6b6b', '#118ab2'];

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

app.get('/api/members', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM members ORDER BY name');
  res.json(rows);
});

app.get('/api/leaves', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT leaves.*, members.name AS member_name, members.color AS member_color
    FROM leaves JOIN members ON leaves.member_id = members.id
    ORDER BY start_date
  `);
  res.json(rows);
});

app.post('/api/leaves', async (req, res) => {
  const { name, start_date, end_date, type, note, half_day } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, end_date are required' });
  }
  if (half_day && start_date !== end_date) {
    return res.status(400).json({ error: 'half_day entries must have start_date === end_date' });
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
    INSERT INTO leaves (member_id, start_date, end_date, type, half_day, note)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [member.id, start_date, end_date, type || 'Leave', half_day || null, note || '']);
  res.json({ id: rows[0].id });
});

app.delete('/api/leaves/:id', async (req, res) => {
  await pool.query('DELETE FROM leaves WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/tasks', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT tasks.*, members.name AS member_name, members.color AS member_color,
           reviewers.name AS reviewer_name, reviewers.color AS reviewer_color
    FROM tasks
    JOIN members ON tasks.member_id = members.id
    LEFT JOIN members AS reviewers ON tasks.reviewer_id = reviewers.id
    ORDER BY (due_date IS NULL), due_date
  `);
  res.json(rows);
});

app.post('/api/tasks', async (req, res) => {
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
  res.json({ id: rows[0].id });
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { status, name, reviewer_name } = req.body;
  if (!status && !name && !reviewer_name) {
    return res.status(400).json({ error: 'status, name, or reviewer_name is required' });
  }

  const { rows: taskRows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  const task = taskRows[0];
  if (!task) return res.status(404).json({ error: 'task not found' });

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
    return res.json({ ok: true });
  }

  if (reviewer_name) {
    const reviewer = await getOrCreateMember(reviewer_name.trim());
    await pool.query(
      'UPDATE tasks SET reviewer_id = $1, status = $2 WHERE id = $3',
      [reviewer.id, 'In Review', req.params.id]
    );
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
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Team leave calendar running at http://localhost:${PORT}`);
      console.log(`Teammates on the same network can use http://<your-ip>:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
