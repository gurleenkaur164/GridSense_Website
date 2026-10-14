// Replays the recorded survey (data/gridsense.json) against /api/ingest exactly like the robot would.
// Use it to test the live pipeline end to end before the real robot is connected.
//
//   ROBOT_API_KEY=... node scripts/robot_simulator.js [baseUrl] [intervalMs]
//   e.g. node scripts/robot_simulator.js https://your-app.vercel.app 1500

const fs = require('fs');
const path = require('path');

const baseUrl = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const intervalMs = Number(process.argv[3] || 1500);
const apiKey = process.env.ROBOT_API_KEY;
if (!apiKey) {
  console.error('Set ROBOT_API_KEY to the same value configured on the server.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'gridsense.json'), 'utf8'));
const byPoint = new Map();
for (const [floor, e, n, mac, rssi, band] of data.samples) {
  const key = `${floor}|${e}|${n}`;
  if (!byPoint.has(key)) byPoint.set(key, []);
  byPoint.get(key).push({ mac, rssi, band });
}

const sessionId = `sim-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`Streaming ${data.trace.length} scan points to ${baseUrl} as session ${sessionId}`);
  let prev = null;
  for (let i = 0; i < data.trace.length; i++) {
    const p = data.trace[i];
    const heading = prev ? (Math.atan2(p.e - prev.e, p.n - prev.n) * 180) / Math.PI : 0;
    const dist = prev && prev.floor === p.floor ? Math.hypot(p.e - prev.e, p.n - prev.n) : 0;
    const body = {
      device_id: 'gridsense-sim',
      session_id: sessionId,
      pose: { floor: p.floor, e: p.e, n: p.n, heading, speed: +(dist / (intervalMs / 1000)).toFixed(2), battery: 100 - (i / data.trace.length) * 40 },
      readings: byPoint.get(`${p.floor}|${p.e}|${p.n}`) || [],
    };
    try {
      const res = await fetch(`${baseUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      console.log(`[${i + 1}/${data.trace.length}] floor ${p.floor} (${p.e}, ${p.n}) -> ${res.status} ${JSON.stringify(out)}`);
    } catch (err) {
      console.error(`[${i + 1}] request failed: ${err.message}`);
    }
    prev = p;
    await sleep(intervalMs);
  }
})();
