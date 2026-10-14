const { getDb, initDb } = require('./db');
const { isRobot } = require('./_auth');

const MAX_READINGS = 500;

/*
  POST /api/ingest   (header: x-api-key: <ROBOT_API_KEY>)
  {
    "device_id": "gridsense-bot-1",
    "session_id": "2026-10-14-run1",
    "pose": { "floor": 1, "e": 52.0, "n": 31.4, "heading": 90, "speed": 0.35, "battery": 87 },
    "readings": [ { "mac": "aa:bb:..", "ssid": "Campus", "rssi": -48, "band": "2.4GHz", "channel": 6 }, ... ]
  }
  "readings" may be empty (heartbeat only). Each reading is stored at the pose position.
*/
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isRobot(req)) return res.status(401).json({ error: 'Invalid device key' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { device_id, session_id, pose, readings = [] } = body;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  if (!device_id || !session_id || !pose || !num(pose.floor) || !num(pose.e) || !num(pose.n)) {
    return res.status(400).json({ error: 'device_id, session_id and pose {floor,e,n} are required' });
  }
  if (!Array.isArray(readings) || readings.length > MAX_READINGS) {
    return res.status(400).json({ error: `readings must be an array of at most ${MAX_READINGS}` });
  }
  const valid = readings.filter((r) => r && typeof r.mac === 'string' && num(r.rssi) && r.rssi < 0 && r.rssi > -120);

  try {
    await initDb();
    const sql = getDb();

    await sql`
      INSERT INTO robot_status (device_id, session_id, floor, e, n, heading, speed, battery, state, updated_at)
      VALUES (${device_id}, ${session_id}, ${pose.floor}, ${pose.e}, ${pose.n},
              ${num(pose.heading) ? pose.heading : null}, ${num(pose.speed) ? pose.speed : null},
              ${num(pose.battery) ? pose.battery : null}, ${pose.state || 'scanning'}, NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        session_id = EXCLUDED.session_id, floor = EXCLUDED.floor, e = EXCLUDED.e, n = EXCLUDED.n,
        heading = EXCLUDED.heading, speed = EXCLUDED.speed, battery = EXCLUDED.battery,
        state = EXCLUDED.state, updated_at = NOW()
    `;

    if (valid.length) {
      await sql`
        INSERT INTO scans (session_id, device_id, floor, e, n, mac, ssid, rssi, band, channel)
        SELECT ${session_id}, ${device_id}, ${pose.floor}, ${pose.e}, ${pose.n}, r.mac, r.ssid, r.rssi, r.band, r.channel
        FROM unnest(
          ${valid.map((r) => r.mac.toUpperCase())}::text[],
          ${valid.map((r) => r.ssid || null)}::text[],
          ${valid.map((r) => r.rssi)}::real[],
          ${valid.map((r) => r.band || null)}::text[],
          ${valid.map((r) => (num(r.channel) ? r.channel : null))}::smallint[]
        ) AS r(mac, ssid, rssi, band, channel)
      `;
    }
    return res.status(200).json({ ok: true, stored: valid.length, rejected: readings.length - valid.length });
  } catch (err) {
    console.error('ingest failed', err);
    return res.status(500).json({ error: 'Failed to store readings' });
  }
};
