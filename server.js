const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'leave.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'Leave',
    half_day TEXT,
    note TEXT,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'Pending Acceptance',
    note TEXT,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  );
`);

const leaveColumns = db.prepare('PRAGMA table_info(leaves)').all().map(c => c.name);
if (!leaveColumns.includes('half_day')) {
  db.exec('ALTER TABLE leaves ADD COLUMN half_day TEXT');
}

const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#43aa8b', '#f3722c', '#577590', '#ff6b6b', '#118ab2'];

const TEAM = ['Jasmine', 'Esri', 'Godwin', 'Richardo', 'Kaushal'];
for (const name of TEAM) {
  const exists = db.prepare('SELECT 1 FROM members WHERE name = ?').get(name);
  if (!exists) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM members').get().c;
    db.prepare('INSERT INTO members (name, color) VALUES (?, ?)').run(name, COLORS[count % COLORS.length]);
  }
}

function findLeaveConflict(memberId, dueDate) {
  if (!dueDate) return null;
  return db.prepare(`
    SELECT * FROM leaves
    WHERE member_id = ? AND ? BETWEEN start_date AND end_date
  `).get(memberId, dueDate) || null;
}

function getOrCreateMember(name) {
  let row = db.prepare('SELECT * FROM members WHERE name = ?').get(name);
  if (row) return row;
  const count = db.prepare('SELECT COUNT(*) AS c FROM members').get().c;
  const color = COLORS[count % COLORS.length];
  const info = db.prepare('INSERT INTO members (name, color) VALUES (?, ?)').run(name, color);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/members', (req, res) => {
  res.json(db.prepare('SELECT * FROM members ORDER BY name').all());
});

app.get('/api/leaves', (req, res) => {
  const rows = db.prepare(`
    SELECT leaves.*, members.name AS member_name, members.color AS member_color
    FROM leaves JOIN members ON leaves.member_id = members.id
    ORDER BY start_date
  `).all();
  res.json(rows);
});

app.post('/api/leaves', (req, res) => {
  const { name, start_date, end_date, type, note, half_day } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, end_date are required' });
  }
  if (half_day && start_date !== end_date) {
    return res.status(400).json({ error: 'half_day entries must have start_date === end_date' });
  }
  const member = getOrCreateMember(name.trim());

  const conflicts = db.prepare(`
    SELECT * FROM tasks
    WHERE member_id = ? AND status != 'Done'
      AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?
  `).all(member.id, start_date, end_date);

  if (conflicts.length > 0) {
    return res.status(409).json({
      error: 'You have unfinished task(s) due in this date range. Reassign or complete them before booking leave.',
      conflicts: conflicts.map(c => ({ title: c.title, due_date: c.due_date, status: c.status }))
    });
  }

  const info = db.prepare(`
    INSERT INTO leaves (member_id, start_date, end_date, type, half_day, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(member.id, start_date, end_date, type || 'Leave', half_day || null, note || '');
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/leaves/:id', (req, res) => {
  db.prepare('DELETE FROM leaves WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/tasks', (req, res) => {
  const rows = db.prepare(`
    SELECT tasks.*, members.name AS member_name, members.color AS member_color
    FROM tasks JOIN members ON tasks.member_id = members.id
    ORDER BY (due_date IS NULL), due_date
  `).all();
  res.json(rows);
});

app.post('/api/tasks', (req, res) => {
  const { name, title, due_date, status, note } = req.body;
  if (!name || !title) {
    return res.status(400).json({ error: 'name and title are required' });
  }
  const member = getOrCreateMember(name.trim());

  const leaveConflict = findLeaveConflict(member.id, due_date);
  if (leaveConflict) {
    return res.status(409).json({
      error: `${name} is on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}. Pick a different due date or assignee.`
    });
  }

  const info = db.prepare(`
    INSERT INTO tasks (member_id, title, due_date, status, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(member.id, title.trim(), due_date || null, status || 'Pending Acceptance', note || '');
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/tasks/:id', (req, res) => {
  const { status, name } = req.body;
  if (!status && !name) return res.status(400).json({ error: 'status or name is required' });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  if (name) {
    const member = getOrCreateMember(name.trim());
    const leaveConflict = findLeaveConflict(member.id, task.due_date);
    if (leaveConflict) {
      return res.status(409).json({
        error: `${name} is on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}. Pick a different assignee.`
      });
    }
    db.prepare('UPDATE tasks SET member_id = ?, status = ? WHERE id = ?')
      .run(member.id, 'Pending Acceptance', req.params.id);
    return res.json({ ok: true });
  }

  if (status === 'Accepted' || status === 'In Progress') {
    const leaveConflict = findLeaveConflict(task.member_id, task.due_date);
    if (leaveConflict) {
      return res.status(409).json({
        error: `You are on approved ${leaveConflict.type} from ${leaveConflict.start_date} to ${leaveConflict.end_date}, which covers this task's due date. Reassign it or change the due date first.`
      });
    }
  }

  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Team leave calendar running at http://localhost:${PORT}`);
  console.log(`Teammates on the same network can use http://<your-ip>:${PORT}`);
});
