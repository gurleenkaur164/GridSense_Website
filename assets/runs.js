// Robot navigation diagnostics: offline exploration logs + live telemetry health.
// Exploration CSV columns: time_s,state,event,T1..T6,heading_deg,x_m,y_m,grid_x,grid_y,
//                          left_distance_cm,right_distance_cm,visited_cells   (T* in mm, -1 = no echo)

const STUCK_WINDOW_S = 10;   // >= STUCK_TURNS completed turns within this window = robot is spinning in place
const STUCK_TURNS = 3;
const SENSOR_DEAD_PCT = 5;   // sensors that return a value less often than this are flagged as dead

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',').map((h) => h.trim());
  return lines.map((l) => {
    const v = l.split(','), r = {};
    head.forEach((h, i) => { const x = v[i]; r[h] = x === undefined || x === '' ? null : (isNaN(+x) ? x : +x); });
    return r;
  });
}

function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }

function analyseRun(rows) {
  const sensorKeys = Object.keys(rows[0]).filter((k) => /^T\d+$/.test(k));
  let path = 0;
  for (let i = 1; i < rows.length; i++) path += Math.hypot(rows[i].x_m - rows[i - 1].x_m, rows[i].y_m - rows[i - 1].y_m);
  const t0 = rows[0].time_s, t1 = rows[rows.length - 1].time_s;
  const dts = rows.slice(1).map((r, i) => r.time_s - rows[i].time_s);

  const sensors = sensorKeys.map((k) => {
    const ok = rows.map((r) => r[k]).filter((v) => v != null && v >= 0);
    return { name: k, validPct: ok.length / rows.length * 100, median: median(ok), min: Math.min(...ok), max: Math.max(...ok) };
  });
  const maxRange = Math.max(...sensors.filter((s) => s.validPct > 0).map((s) => s.max));

  const events = rows.filter((r) => r.event).map((r) => ({ t: r.time_s, event: r.event, x: r.x_m, y: r.y_m, heading: r.heading_deg }));
  const turns = events.filter((e) => e.event.startsWith('TURN COMPLETE'));
  // turn accuracy: how far each completed turn ends from the nearest multiple of 90° (relative to the start heading)
  const h0 = rows[0].heading_deg;
  const turnErr = turns.map((e) => { const d = angDiff(e.heading, h0); return Math.abs(d - Math.round(d / 90) * 90); });

  // spinning in place: several turns completed within a short window
  const stuck = [];
  for (let i = 0; i < turns.length; i++) {
    const w = turns.filter((e) => e.t >= turns[i].t && e.t - turns[i].t <= STUCK_WINDOW_S);
    if (w.length >= STUCK_TURNS && !stuck.some((s) => turns[i].t <= s.tEnd)) {
      stuck.push({ t: turns[i].t, tEnd: w[w.length - 1].t, n: w.length, x: turns[i].x, y: turns[i].y });
    }
  }
  events.filter((e) => e.event === 'TURN TIMEOUT').forEach((e) => {
    if (!stuck.some((s) => Math.hypot(s.x - e.x, s.y - e.y) < 0.5)) stuck.push({ t: e.t, tEnd: e.t, n: 1, x: e.x, y: e.y, timeout: true });
  });

  // heading drift on straight segments (EXPLORE stretches longer than 1 m)
  const drifts = [];
  let seg = [];
  const flush = () => {
    let L = 0; for (let i = 1; i < seg.length; i++) L += Math.hypot(seg[i].x_m - seg[i - 1].x_m, seg[i].y_m - seg[i - 1].y_m);
    if (L > 1) drifts.push({ len: L, drift: angDiff(seg[seg.length - 1].heading_deg, seg[0].heading_deg) });
    seg = [];
  };
  rows.forEach((r) => { if (r.state === 'EXPLORE') seg.push(r); else if (seg.length) flush(); });
  if (seg.length) flush();

  const last = rows[rows.length - 1];
  const exploreRows = rows.filter((r) => r.state === 'EXPLORE');
  return {
    rows, sensors, maxRange, events, turns, turnErr, stuck, drifts,
    duration: t1 - t0, path, dtMedian: median(dts), dtMax: Math.max(...dts),
    turningPct: (rows.length - exploreRows.length) / rows.length * 100,
    cells: last.visited_cells,
    // grid pitch: median of x/grid_x, rounded to 5 cm (grid indices are rounded positions)
    cellSize: (() => { const v = rows.filter((x) => Math.abs(x.grid_x) > 4).map((x) => x.x_m / x.grid_x); return v.length ? Math.round(median(v) * 20) / 20 : null; })(),
    speed: path / Math.max(1e-6, exploreRows.length ? (t1 - t0) * exploreRows.length / rows.length : t1 - t0),
    wheel: { l: last.left_distance_cm, r: last.right_distance_cm },
    extent: { x0: Math.min(...rows.map((r) => r.x_m)), x1: Math.max(...rows.map((r) => r.x_m)), y0: Math.min(...rows.map((r) => r.y_m)), y1: Math.max(...rows.map((r) => r.y_m)) },
  };
}

// ======================================================
//  EXPLORATION RUNS CARD
// ======================================================
const RUNS = new Map();
const runCanvas = $('runCanvas'), rctx = runCanvas.getContext('2d');
let currentRun = null;

function addRun(name, text) {
  try {
    const rows = parseCsv(text).filter((r) => Number.isFinite(r.x_m) && Number.isFinite(r.y_m));
    if (rows.length < 2) throw new Error('no rows');
    RUNS.set(name, analyseRun(rows));
  } catch (err) {
    alert(`Could not read ${name}: expected an exploration_*.csv log.`);
    return;
  }
  $('runSelect').innerHTML = [...RUNS.keys()].map((k) => `<option ${k === name ? 'selected' : ''}>${esc(k)}</option>`).join('');
  showRun(name);
}

function showRun(name) {
  currentRun = RUNS.get(name);
  if (!currentRun) return;
  drawRun(); renderRunStats();
}

function drawRun() {
  const A = currentRun; if (!A) return;
  const dpr = window.devicePixelRatio || 1;
  const W = runCanvas.clientWidth, pad = { l: 46, r: 14, t: 12, b: 36 };
  const ex = { x0: A.extent.x0 - .5, x1: A.extent.x1 + .5, y0: A.extent.y0 - .5, y1: A.extent.y1 + .5 };
  const sc = Math.min((W - pad.l - pad.r) / (ex.x1 - ex.x0), 300 / (ex.y1 - ex.y0));
  const H = Math.max(160, sc * (ex.y1 - ex.y0) + pad.t + pad.b);
  runCanvas.width = W * dpr; runCanvas.height = H * dpr; runCanvas.style.height = H + 'px';
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const X = (x) => pad.l + (x - ex.x0) * sc, Y = (y) => pad.t + (ex.y1 - y) * sc;
  rctx.fillStyle = css('--bg'); rctx.fillRect(0, 0, W, H);

  // visited 25 cm cells
  const cs = A.cellSize || .25;
  rctx.fillStyle = 'rgba(232,67,147,.10)';
  const seen = new Set();
  for (const r of A.rows) {
    const k = r.grid_x + ',' + r.grid_y; if (seen.has(k)) continue; seen.add(k);
    rctx.fillRect(X(r.grid_x * cs - cs / 2), Y(r.grid_y * cs + cs / 2), cs * sc, cs * sc);
  }
  // axes
  rctx.strokeStyle = css('--border'); rctx.fillStyle = css('--text2'); rctx.font = '10px "DM Sans"'; rctx.lineWidth = 1;
  rctx.textAlign = 'center';
  for (let x = Math.ceil(ex.x0); x <= ex.x1; x++) { rctx.beginPath(); rctx.moveTo(X(x), Y(ex.y1)); rctx.lineTo(X(x), Y(ex.y0)); rctx.stroke(); rctx.fillText(x, X(x), H - pad.b + 13); }
  rctx.textAlign = 'right';
  for (let y = Math.ceil(ex.y0); y <= ex.y1; y++) { rctx.beginPath(); rctx.moveTo(X(ex.x0), Y(y)); rctx.lineTo(X(ex.x1), Y(y)); rctx.stroke(); rctx.fillText(y, X(ex.x0) - 5, Y(y) + 3); }
  rctx.font = '600 11px "DM Sans"'; rctx.textAlign = 'center';
  rctx.fillText('x (m, robot odometry)', X((ex.x0 + ex.x1) / 2), H - 4);
  rctx.save(); rctx.translate(12, Y((ex.y0 + ex.y1) / 2)); rctx.rotate(-Math.PI / 2); rctx.fillText('y (m)', 0, 0); rctx.restore();

  // path coloured by state
  for (let i = 1; i < A.rows.length; i++) {
    const a = A.rows[i - 1], b = A.rows[i];
    rctx.strokeStyle = b.state === 'TURNING' ? '#e09100' : css('--pink'); rctx.lineWidth = 2;
    rctx.beginPath(); rctx.moveTo(X(a.x_m), Y(a.y_m)); rctx.lineTo(X(b.x_m), Y(b.y_m)); rctx.stroke();
  }
  // events
  for (const e of A.events) {
    const x = X(e.x), y = Y(e.y);
    if (e.event === 'FRONT OBSTACLE') { rctx.fillStyle = css('--red'); rctx.fillRect(x - 4, y - 4, 8, 8); }
    else if (e.event.startsWith('TURN COMPLETE')) { rctx.fillStyle = '#2e86de'; rctx.beginPath(); rctx.arc(x, y, 3.5, 0, Math.PI * 2); rctx.fill(); }
  }
  for (const s of A.stuck) {
    rctx.strokeStyle = css('--red'); rctx.lineWidth = 2; rctx.beginPath(); rctx.arc(X(s.x), Y(s.y), 14, 0, Math.PI * 2); rctx.stroke();
    const right = X(s.x) > W * 0.6;
    rctx.fillStyle = css('--red'); rctx.font = 'bold 10px "DM Sans"'; rctx.textAlign = right ? 'right' : 'left';
    rctx.fillText(s.timeout ? 'turn timeout' : `stuck: ${s.n} turns / ${(s.tEnd - s.t).toFixed(0)} s`, X(s.x) + (right ? -16 : 16), Y(s.y) + (s.timeout ? -10 : 18));
  }
  const s0 = A.rows[0], s1 = A.rows[A.rows.length - 1];
  rctx.fillStyle = css('--green'); rctx.beginPath(); rctx.arc(X(s0.x_m), Y(s0.y_m), 5, 0, Math.PI * 2); rctx.fill();
  rctx.fillStyle = css('--text'); rctx.beginPath(); rctx.arc(X(s1.x_m), Y(s1.y_m), 5, 0, Math.PI * 2); rctx.fill();

  $('runLegend').innerHTML = `<span class="legend-item"><span class="sw" style="background:var(--pink)"></span>exploring</span>
    <span class="legend-item"><span class="sw" style="background:#e09100"></span>turning</span>
    <span class="legend-item"><span class="sw" style="background:#2e86de;border-radius:50%"></span>turn complete</span>
    <span class="legend-item"><span class="sw" style="background:var(--red)"></span>front obstacle</span>
    <span class="legend-item"><span class="sw" style="background:rgba(232,67,147,.25)"></span>visited ${Math.round((A.cellSize || .25) * 100)} cm cell</span>
    <span class="legend-item"><span class="sw" style="background:var(--green);border-radius:50%"></span>start · <span class="sw" style="background:var(--text);border-radius:50%"></span>end</span>`;
}

function sensorBars(sensors) {
  return sensors.map((s) => {
    const dead = s.validPct < SENSOR_DEAD_PCT, col = dead ? 'var(--red)' : s.validPct < 50 ? 'var(--yellow)' : 'var(--green)';
    return `<div class="sensor-row"><span class="name">${s.name}</span><span class="bar"><i style="width:${Math.max(2, s.validPct)}%;background:${col}"></i></span>
      <span style="width:150px;text-align:right;font-family:var(--mono);font-size:.7rem">${dead ? '<b style="color:var(--red)">no echo</b>' : `${s.validPct.toFixed(0)}% · med ${(s.median / 1000).toFixed(2)} m`}</span></div>`;
  }).join('');
}

function renderRunStats() {
  const A = currentRun;
  const dead = A.sensors.filter((s) => s.validPct < SENSOR_DEAD_PCT).map((s) => s.name);
  const meanTurnErr = mean(A.turnErr), maxDrift = A.drifts.length ? Math.max(...A.drifts.map((d) => Math.abs(d.drift))) : 0;
  const issues = [];
  if (dead.length) issues.push(`<div class="warnbox"><b>${dead.join(', ')}</b> returned no readings — check wiring / power.</div>`);
  A.stuck.forEach((s) => issues.push(`<div class="warnbox"><b>${s.timeout ? 'Turn timeout' : 'Spinning in place'}</b> at (${fmt(s.x, 2)}, ${fmt(s.y, 2)}) m${s.timeout ? '' : `: ${s.n} turns in ${(s.tEnd - s.t).toFixed(0)} s`} — add a back-up / escape manoeuvre.</div>`));
  if (A.turns.length && meanTurnErr > 8) issues.push(`<div class="warnbox">Turns end on average <b>${meanTurnErr.toFixed(0)}°</b> away from a 90° step — position estimates will drift on long runs.</div>`);
  if (maxDrift > 5) issues.push(`<div class="warnbox">Heading drifts up to <b>${maxDrift.toFixed(0)}°</b> on straight stretches — the robot curves while exploring.</div>`);
  if (!issues.length) issues.push('<div class="okbox">No navigation issues detected.</div>');
  const scanEvery = A.speed * 2.5;
  $('runStats').innerHTML = `
    <table><tbody>
      <tr><td>Duration</td><td class="num">${A.duration.toFixed(0)} s</td></tr>
      <tr><td>Distance driven (odometry)</td><td class="num">${A.path.toFixed(2)} m</td></tr>
      <tr><td>Area spanned</td><td class="num">${(A.extent.x1 - A.extent.x0).toFixed(1)} × ${(A.extent.y1 - A.extent.y0).toFixed(1)} m · ${A.cells} cells</td></tr>
      <tr><td>Time spent turning</td><td class="num">${A.turningPct.toFixed(0)}%</td></tr>
      <tr><td>Exploring speed</td><td class="num">${A.speed.toFixed(2)} m/s</td></tr>
      <tr><td>Turns · obstacles</td><td class="num">${A.turns.length} · ${A.events.filter((e) => e.event === 'FRONT OBSTACLE').length}</td></tr>
      <tr><td>Wheel distance L / R</td><td class="num">${(A.wheel.l / 100).toFixed(2)} / ${(A.wheel.r / 100).toFixed(2)} m</td></tr>
      <tr><td>Log interval (median / max)</td><td class="num">${A.dtMedian.toFixed(2)} / ${A.dtMax.toFixed(2)} s</td></tr>
      <tr><td>WiFi scan spacing at this speed</td><td class="num" title="assuming ~2.5 s per WiFi scan while moving">≈ ${scanEvery.toFixed(2)} m</td></tr>
    </tbody></table>
    <div style="margin-top:.8rem"><div class="tb-label" style="margin-bottom:.3rem">Distance sensors (valid readings · median · max ${(A.maxRange / 1000).toFixed(2)} m)</div>${sensorBars(A.sensors)}</div>
    <div style="margin-top:.8rem">${issues.join('')}</div>`;
}

$('runSelect').addEventListener('change', (e) => showRun(e.target.value));
$('runUpload').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  addRun(f.name, await f.text()); e.target.value = '';
});
window.addEventListener('resize', () => drawRun());

(async function loadRuns() {
  try {
    const names = await (await fetch('data/runs/index.json')).json();
    for (const n of names) addRun(n, await (await fetch('data/runs/' + n)).text());
    if (names.length) { $('runSelect').value = names[0]; showRun(names[0]); }
  } catch (err) {
    $('runStats').innerHTML = '<p class="card-sub">Upload an exploration_*.csv log to analyse a run.</p>';
  }
})();

// ======================================================
//  LIVE ROBOT HEALTH (fed by /api/live polling in app.js)
// ======================================================
const sensorHistory = [];   // last sensor snapshots, one per poll
function renderHealth(robots, events) {
  const r = robots && robots[0];
  if (!r || (!r.sensors && !r.last_event && r.x_local == null)) {
    $('healthBadge').textContent = r ? 'no navigation telemetry' : 'no robot';
    $('health').innerHTML = `<p class="card-sub">${r ? 'The robot is sending scans but no navigation telemetry yet.' : 'No robot has connected yet.'}
      Send <code>telemetry: { state, event, sensors: [T1..T6], wheel_l_cm, wheel_r_cm }</code> with each <code>/api/ingest</code> call to see sensor health, events and stuck detection here.</p>`;
    return;
  }
  if (r.sensors && (!sensorHistory.length || sensorHistory[sensorHistory.length - 1].t !== r.updated_at)) {
    sensorHistory.push({ t: r.updated_at, v: r.sensors });
    if (sensorHistory.length > 100) sensorHistory.shift();
  }
  const nS = sensorHistory.length ? sensorHistory[sensorHistory.length - 1].v.length : 0;
  const sensors = Array.from({ length: nS }, (_, i) => {
    const vals = sensorHistory.map((h) => h.v[i]).filter((v) => v != null && v >= 0);
    return { name: 'T' + (i + 1), validPct: vals.length / sensorHistory.length * 100, median: median(vals) };
  });
  const online = r.age_s < ROBOT_ONLINE_S;
  $('healthBadge').textContent = online ? r.state || 'online' : 'offline';

  const evs = (events || []).map((e) => ({ t: new Date(e.created_at).getTime() / 1000, event: e.event, e: e.e, n: e.n }));
  const turns = evs.filter((e) => e.event.startsWith('TURN COMPLETE')).sort((a, b) => a.t - b.t);
  let stuck = null;
  for (let i = 0; i < turns.length; i++) {
    const w = turns.filter((e) => e.t >= turns[i].t && e.t - turns[i].t <= STUCK_WINDOW_S);
    if (w.length >= STUCK_TURNS) stuck = { ...turns[i], n: w.length };
  }
  const timeout = evs.find((e) => e.event === 'TURN TIMEOUT');
  const dead = sensors.filter((s) => sensorHistory.length >= 5 && s.validPct < SENSOR_DEAD_PCT).map((s) => s.name);
  const warn = [];
  if (!online) warn.push(`<div class="warnbox">No update for ${ago(r.age_s)}.</div>`);
  if (dead.length) warn.push(`<div class="warnbox"><b>${dead.join(', ')}</b>: no echo in the last ${sensorHistory.length} updates.</div>`);
  if (stuck) warn.push(`<div class="warnbox">Spinning in place near (${fmt(stuck.e)} E, ${fmt(stuck.n)} N): ${stuck.n} turns within ${STUCK_WINDOW_S} s.</div>`);
  if (timeout) warn.push(`<div class="warnbox">Turn timeout at ${new Date(timeout.t * 1000).toLocaleTimeString()}.</div>`);
  if (r.battery != null && r.battery < 20) warn.push(`<div class="warnbox">Battery low: ${Math.round(r.battery)}%.</div>`);
  if (!warn.length) warn.push('<div class="okbox">All systems normal.</div>');

  $('health').innerHTML = `<div class="health-grid">
    <div class="hbox"><h4>Status</h4>${esc(r.device_id)} · <b>${esc(r.state || '–')}</b><br>Floor ${r.floor} · (${fmt(r.e)} E, ${fmt(r.n)} N)<br>
      ${r.x_local != null ? `Odometry (${fmt(r.x_local, 2)}, ${fmt(r.y_local, 2)}) m<br>` : ''}Heading ${fmt(r.heading, 0)}° · ${r.speed != null ? fmt(r.speed, 2) + ' m/s' : '–'}<br>
      Battery ${r.battery != null ? Math.round(r.battery) + '%' : '–'} · updated ${ago(r.age_s)}</div>
    <div class="hbox"><h4>Distance sensors</h4>${sensors.length ? sensorBars(sensors) : 'No sensor data.'}</div>
    <div class="hbox"><h4>Recent events</h4>${evs.length ? evs.slice(0, 8).map((e) => `<div style="font-family:var(--mono);font-size:.7rem">${new Date(e.t * 1000).toLocaleTimeString()} ${esc(e.event)}</div>`).join('') : 'None yet.'}
      ${r.wheel_l_cm != null ? `<div style="margin-top:.4rem">Wheels L/R: ${fmt(r.wheel_l_cm / 100, 2)} / ${fmt(r.wheel_r_cm / 100, 2)} m</div>` : ''}</div>
    <div class="hbox"><h4>Alerts</h4>${warn.join('')}</div></div>`;
}
renderHealth([], []);
