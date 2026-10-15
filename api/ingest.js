const { getDb, initDb } = require('./db');
const { isRobot } = require('./_auth');

const MAX_READINGS = 500;

/*
  POST /api/ingest   (header: x-api-key: <ROBOT_API_KEY>)
  {
    "device_id": "gridsense-bot-1",
    "session_id": "2026-10-14-run1",
    "pose": { "floor": 1, "e": 52.0, "n": 31.4, "heading": 90, "speed": 0.35, "battery": 87 },
    "readings": [ { "mac": "aa:bb:..", "ssid": "Campus", "rssi": -48, "band": "2.4GHz", "channel": 6 }, ... ],
    "telemetry": { "state": "EXPLORE", "event": "FRONT OBSTACLE", "sensors": [-1, 643, 963, -1, 1031, -1],
                   "wheel_l_cm": 120.4, "wheel_r_cm": 118.9 }
  }

  The pose can also be sent in the robot's own odometry frame (as in the exploration logs):
    "pose": { "frame": "local", "x": 4.12, "y": -1.13, "heading": -104,
              "origin": { "floor": 1, "e": 52.0, "n": 15.0, "theta": 0 } }
  origin = where the robot started on the survey map; theta = direction of the robot's +x axis,
  in degrees counter-clockwise from North towards East. The server converts it to floor/e/n.

  "readings" may be empty (heartbeat only). Each reading is stored at the pose position.
*/
const num = (v) => typeof v === 'number' && Number.isFinite(v);

function resolvePose(pose) {
  if (pose.frame !== 'local') return pose;
  const o = pose.origin || {};
  if (!num(pose.x) || !num(pose.y) || !num(o.floor) || !num(o.e) || !num(o.n)) return null;
  const deg = num(o.theta) ? o.theta : 0;
  const th = (deg * Math.PI) / 180;
  return {
    ...pose,
    floor: o.floor,
    n: o.n + pose.x * Math.cos(th) - pose.y * Math.sin(th),
    e: o.e + pose.x * Math.sin(th) + pose.y * Math.cos(th),
    heading: num(pose.heading) ? pose.heading + deg : null,
    x_local: pose.x,
    y_local: pose.y,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isRobot(req)) return res.status(401).json({ error: 'Invalid device key' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { device_id, session_id, readings = [], telemetry = {} } = body;
  const pose = body.pose && resolvePose(body.pose);

  if (!device_id || !session_id || !pose || !num(pose.floor) || !num(pose.e) || !num(pose.n)) {
    return res.status(400).json({ error: 'device_id, session_id and pose {floor,e,n} (or local x,y + origin) are required' });
  }
  if (!Array.isArray(readings) || readings.length > MAX_READINGS) {
    return res.status(400).json({ error: `readings must be an array of at most ${MAX_READINGS}` });
  }
  const valid = readings.filter((r) => r && typeof r.mac === 'string' && num(r.rssi) && r.rssi < 0 && r.rssi > -120);
  const sensors = Array.isArray(telemetry.sensors) && telemetry.sensors.length <= 16 && telemetry.sensors.every(num)
    ? JSON.stringify(telemetry.sensors) : null;
  const event = typeof telemetry.event === 'string' && telemetry.event.trim() ? telemetry.event.trim().slice(0, 64) : null;
  const state = String((typeof telemetry.state === 'string' && telemetry.state) || pose.state || 'scanning').slice(0, 32);
  const opt = (v) => (num(v) ? v : null);

  try {
    await initDb();
    const sql = getDb();

    await sql`
      INSERT INTO robot_status (device_id, session_id, floor, e, n, heading, speed, battery, state,
                                x_local, y_local, sensors, wheel_l_cm, wheel_r_cm, last_event, updated_at)
      VALUES (${device_id}, ${session_id}, ${pose.floor}, ${pose.e}, ${pose.n},
              ${opt(pose.heading)}, ${opt(pose.speed)}, ${opt(pose.battery)}, ${state},
              ${opt(pose.x_local)}, ${opt(pose.y_local)}, ${sensors}::jsonb,
              ${opt(telemetry.wheel_l_cm)}, ${opt(telemetry.wheel_r_cm)}, ${event}, NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        session_id = EXCLUDED.session_id, floor = EXCLUDED.floor, e = EXCLUDED.e, n = EXCLUDED.n,
        heading = EXCLUDED.heading, speed = EXCLUDED.speed, battery = EXCLUDED.battery,
        state = EXCLUDED.state, x_local = EXCLUDED.x_local, y_local = EXCLUDED.y_local,
        sensors = COALESCE(EXCLUDED.sensors, robot_status.sensors),
        wheel_l_cm = COALESCE(EXCLUDED.wheel_l_cm, robot_status.wheel_l_cm),
        wheel_r_cm = COALESCE(EXCLUDED.wheel_r_cm, robot_status.wheel_r_cm),
        last_event = COALESCE(EXCLUDED.last_event, robot_status.last_event),
        updated_at = NOW()
    `;

    if (event) {
      await sql`
        INSERT INTO robot_events (device_id, session_id, event, floor, e, n, heading)
        VALUES (${device_id}, ${session_id}, ${event}, ${pose.floor}, ${pose.e}, ${pose.n}, ${opt(pose.heading)})
      `;
    }

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
    return res.status(200).json({
      ok: true, stored: valid.length, rejected: readings.length - valid.length,
      pose: { floor: pose.floor, e: +pose.e.toFixed(2), n: +pose.n.toFixed(2) },
    });
  } catch (err) {
    console.error('ingest failed', err);
    return res.status(500).json({ error: 'Failed to store readings' });
  }
};
