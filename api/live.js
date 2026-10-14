const { getDb, initDb } = require('./db');
const { userFromRequest } = require('./_auth');

/*
  GET /api/live?since=<last scan id>&session=<session id, optional>
  Returns robots' latest status, known sessions, and scans newer than `since`.
  The dashboard polls this every few seconds.
*/
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!userFromRequest(req)) return res.status(401).json({ error: 'Not authenticated' });

  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  try {
    await initDb();
    const sql = getDb();

    const robots = await sql`
      SELECT device_id, session_id, floor, e, n, heading, speed, battery, state, updated_at,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) AS age_s
      FROM robot_status ORDER BY updated_at DESC
    `;
    const sessions = await sql`
      SELECT session_id, COUNT(*)::int AS readings, MIN(created_at) AS started, MAX(created_at) AS last_seen
      FROM scans GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 20
    `;
    const session = req.query.session || (sessions[0] && sessions[0].session_id);
    const scans = session ? await sql`
      SELECT id, floor, e, n, mac, ssid, rssi, band, channel, created_at
      FROM scans WHERE session_id = ${session} AND id > ${since}
      ORDER BY id ASC LIMIT 5000
    ` : [];

    return res.status(200).json({ robots, sessions, session, scans });
  } catch (err) {
    console.error('live failed', err);
    return res.status(500).json({ error: 'Database unavailable' });
  }
};
