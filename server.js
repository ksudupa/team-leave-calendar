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
    note TEXT,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  );
`);

const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#9b5de5', '#43aa8b', '#f3722c', '#577590', '#ff6b6b', '#118ab2'];

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
  const { name, start_date, end_date, type, note } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, end_date are required' });
  }
  const member = getOrCreateMember(name.trim());
  const info = db.prepare(`
    INSERT INTO leaves (member_id, start_date, end_date, type, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(member.id, start_date, end_date, type || 'Leave', note || '');
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/leaves/:id', (req, res) => {
  db.prepare('DELETE FROM leaves WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Team leave calendar running at http://localhost:${PORT}`);
  console.log(`Teammates on the same network can use http://<your-ip>:${PORT}`);
});
