const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    const sql = getDb();
    const users = await sql`SELECT id, name, email, created_at FROM users WHERE id = ${decoded.id}`;

    if (users.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    return res.status(200).json({ user: users[0] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
