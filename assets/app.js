// GridSense dashboard
// Sources: "baseline" = analysis-pipeline output for the recorded survey,
//          "live"     = robot scans from /api/live, "replay" = recorded survey streamed in-browser.
// Live and replay readings go through the same per-cell feature extraction and
// cluster assignment as the pipeline, so replay converges to the survey results.

// ======================================================
//  STATE
// ======================================================
const POLL_MS = 3000;
const ROBOT_ONLINE_S = 30;
const SNAP_M = 1.5;          // a scan point joins the nearest survey cell within this distance
const NEW_CELL_M = 2;        // otherwise it is binned onto a new 2 m cell (survey grid pitch)

const S = {
  model: null,
  source: 'baseline',
  floor: 1,
  layer: 'signal',
  show: { aps: true, truth: false, path: true },
  live: { since: 0, session: null, sessions: [], robots: [], samples: [], points: [], apiOk: null },
  replay: { idx: 0, timer: null, samples: [], points: [] },
  cells: [],
  robot: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const std = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (v, d = 1) => (v == null || !Number.isFinite(+v)) ? '–' : (+v).toFixed(d);
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('signalscope-theme', next);
  renderAll();
}
function logout() {
  localStorage.removeItem('token'); localStorage.removeItem('userName');
  window.location.href = '/login.html';
}

// ======================================================
//  CLUSTER MODEL (exported from the pipeline: nearest standardised centroid)
// ======================================================
function assignCluster(cell) {
  const cm = S.model.cluster_model;
  const z = cm.features.map((f, i) => {
    const v = cell[f] == null || !Number.isFinite(+cell[f]) ? cm.fill[i] : +cell[f];
    return (v - cm.mean[i]) / cm.std[i];
  });
  let best = null, bd = Infinity;
  for (const c of cm.clusters) {
    const d = c.centroid.reduce((s, v, i) => s + (z[i] - v) ** 2, 0);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ======================================================
//  AGGREGATION — raw readings -> scan points -> grid cells
// ======================================================
function aggregate(samples, source) {
  // 1. scan points: one per robot stop; one value per BSSID (strongest if repeated)
  const points = new Map();
  for (const s of samples) {
    const k = `${s.floor}|${s.e}|${s.n}`;
    let p = points.get(k);
    if (!p) { p = { floor: s.floor, e: s.e, n: s.n, macs: new Map() }; points.set(k, p); }
    const prev = p.macs.get(s.mac);
    if (!prev || s.rssi > prev.rssi) p.macs.set(s.mac, { rssi: s.rssi, channel: s.channel });
  }

  // 2. per-point features, snapped onto survey cells
  const survey = S.model.cellsByFloor;
  const cells = new Map();
  for (const p of points.values()) {
    const v = [...p.macs.values()].sort((a, b) => b.rssi - a.rssi);
    const r = v.map((x) => x.rssi);
    const bestCh = v[0].channel;
    const feat = {
      best: r[0], all: mean(r), nVis: r.length, gap: r.length > 1 ? r[0] - r[1] : null,
      cochan: bestCh != null ? v.filter((x, i) => i > 0 && x.channel === bestCh).length : null,
    };
    let host = null, hd = Infinity;
    for (const c of survey.get(p.floor) || []) {
      const d = Math.hypot(c.e - p.e, c.n - p.n);
      if (d < hd) { hd = d; host = c; }
    }
    let key, base;
    if (host && hd <= SNAP_M) { key = `s${host.idx}`; base = host; }
    else {
      const ge = Math.round(p.e / NEW_CELL_M) * NEW_CELL_M, gn = Math.round(p.n / NEW_CELL_M) * NEW_CELL_M;
      key = `${p.floor}|${ge}|${gn}`; base = { floor: p.floor, e: ge, n: gn, isNew: true };
    }
    if (!cells.has(key)) cells.set(key, { base, pts: [] });
    cells.get(key).pts.push(feat);
  }

  // 3. cell features — same definitions as the pipeline grid
  const out = [];
  for (const { base, pts } of cells.values()) {
    const fromSurvey = source === 'replay' && !base.isNew;
    const cochan = pts.map((p) => p.cochan).filter((x) => x != null);
    const cell = {
      floor: base.floor, e: base.e, n: base.n,
      rssi_best_mean: mean(pts.map((p) => p.best)),
      rssi_spatial_std: std(pts.map((p) => p.best)),
      rssi_all_mean: mean(pts.map((p) => p.all)),
      best_second_gap: (() => { const g = pts.map((p) => p.gap).filter((x) => x != null); return g.length ? mean(g) : null; })(),
      n_samples: pts.length,
      // residuals.parquet only holds the 25 mapped APs, so replay takes the visible-network
      // count and contention from the survey grid; the live robot reports full scans.
      n_aps_visible: fromSurvey ? base.n_aps_visible : mean(pts.map((p) => p.nVis)),
      contention: fromSurvey ? base.contention : (cochan.length ? mean(cochan) : null),
      contention_projected_1_6_11: fromSurvey ? base.contention_projected_1_6_11 : null,
      featureSource: fromSurvey ? 'survey' : 'measured',
      surveyCell: base.isNew ? null : base,
    };
    const c = assignCluster(cell);
    cell.cluster = c.cluster; cell.cluster_name = c.name; cell.action = c.action;
    out.push(cell);
  }
  return out;
}

// ======================================================
//  SOURCES
// ======================================================
function currentCells() {
  if (S.source === 'baseline') return S.model.cells;
  return aggregate(S.source === 'live' ? S.live.samples : S.replay.samples, S.source);
}
function currentPoints() {
  if (S.source === 'baseline') return S.model.trace;
  return S.source === 'live' ? S.live.points : S.replay.points;
}

function setSource(src) {
  S.source = src;
  document.querySelectorAll('#sourceSeg .btn').forEach((b) => b.classList.toggle('active', b.dataset.src === src));
  $('sessionSelect').style.display = src === 'live' && S.live.sessions.length ? '' : 'none';
  if (src === 'replay') startReplay(); else stopReplay();
  S.robot = src === 'live' ? liveRobot() : src === 'replay' ? S.robot : null;
  refresh(true);
}

// ---------- Live (database) ----------
function liveRobot() {
  const r = S.live.robots.find((x) => x.session_id === S.live.session) || S.live.robots[0];
  return r && r.floor != null ? { floor: +r.floor, e: +r.e, n: +r.n, heading: r.heading } : null;
}

async function pollLive() {
  const token = localStorage.getItem('token');
  try {
    const q = new URLSearchParams({ since: S.live.since });
    if (S.live.session) q.set('session', S.live.session);
    const res = await fetch('/api/live?' + q, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return logout();
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    S.live.apiOk = true;
    S.live.robots = d.robots || [];
    S.live.sessions = d.sessions || [];
    if (!S.live.session && d.session) S.live.session = d.session;
    renderSessionSelect();

    const fresh = (d.scans || []).map((s) => ({ id: +s.id, floor: +s.floor, e: +s.e, n: +s.n, mac: s.mac, ssid: s.ssid, rssi: +s.rssi, band: s.band, channel: s.channel, t: s.created_at }));
    for (const s of fresh) { S.live.samples.push(s); S.live.since = Math.max(S.live.since, s.id); }
    if (fresh.length) { groupPoints(fresh, S.live.points); if (S.source === 'live') pushFeed(fresh); }

    const online = S.live.robots.some((r) => r.age_s < ROBOT_ONLINE_S);
    if (online && !S.live.autoSwitched && S.source === 'baseline') { S.live.autoSwitched = true; setSource('live'); }
    if (S.source === 'live') { S.robot = liveRobot(); if (fresh.length || online) refresh(); }
  } catch (err) {
    S.live.apiOk = false;
  }
  renderStatus();
}

function renderSessionSelect() {
  const sel = $('sessionSelect');
  const html = S.live.sessions.map((s) => `<option value="${esc(s.session_id)}" ${s.session_id === S.live.session ? 'selected' : ''}>${esc(s.session_id)} · ${s.readings} readings</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.style.display = S.source === 'live' && S.live.sessions.length ? '' : 'none';
}
$('sessionSelect').addEventListener('change', (e) => {
  S.live.session = e.target.value; S.live.since = 0; S.live.samples = []; S.live.points = [];
  $('feed').innerHTML = ''; pollLive();
});

// scan points in arrival order (signal chart, path)
function groupPoints(readings, into) {
  for (const r of readings) {
    const last = into[into.length - 1];
    if (last && last.floor === r.floor && last.e === r.e && last.n === r.n) { last.best = Math.max(last.best, r.rssi); last.count++; }
    else into.push({ floor: r.floor, e: r.e, n: r.n, best: r.rssi, count: 1, t: r.t });
  }
}

// ---------- Replay ----------
let replayQueue = null;
function startReplay() {
  if (!replayQueue) {
    const byPoint = new Map();
    for (const [floor, e, n, mac, rssi, band] of S.model.samples) {
      const k = `${floor}|${e}|${n}`;
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k).push({ floor, e, n, mac, rssi, band });
    }
    replayQueue = S.model.trace.map((p) => byPoint.get(`${p.floor}|${p.e}|${p.n}`) || []);
  }
  if (S.replay.idx >= replayQueue.length) { S.replay = { idx: 0, timer: null, samples: [], points: [] }; $('feed').innerHTML = ''; }
  clearInterval(S.replay.timer);
  S.replay.timer = setInterval(stepReplay, 120);
}
function stopReplay() { clearInterval(S.replay.timer); S.replay.timer = null; }
function stepReplay() {
  if (S.replay.idx >= replayQueue.length) { stopReplay(); refresh(true); return; }
  const batch = replayQueue[S.replay.idx++];
  if (!batch.length) return;
  const t = new Date().toISOString();
  batch.forEach((b) => (b.t = t));
  S.replay.samples.push(...batch);
  groupPoints(batch, S.replay.points);
  const p = S.replay.points[S.replay.points.length - 1], prev = S.replay.points[S.replay.points.length - 2];
  S.robot = { floor: p.floor, e: p.e, n: p.n, heading: prev && prev.floor === p.floor ? Math.atan2(p.e - prev.e, p.n - prev.n) * 180 / Math.PI : 0 };
  if (S.robot.floor !== S.floor) selectFloor(S.robot.floor);
  pushFeed(batch);
  refresh();
}

// ======================================================
//  STATUS
// ======================================================
function renderStatus() {
  const rp = $('robotPill'), dp = $('dataPill');
  const r = S.live.robots[0];
  rp.className = 'pill';
  if (S.live.apiOk === false) { $('robotPillText').textContent = 'Robot API offline'; rp.classList.add('warn'); }
  else if (r && r.age_s < ROBOT_ONLINE_S) {
    rp.classList.add('on');
    $('robotPillText').textContent = `${r.device_id} online · F${r.floor}` + (r.battery != null ? ` · ${Math.round(r.battery)}%` : '');
  } else if (r) $('robotPillText').textContent = `${r.device_id} last seen ${ago(r.age_s)}`;
  else $('robotPillText').textContent = 'No robot connected yet';

  dp.className = 'pill';
  if (S.source === 'baseline') $('dataPillText').textContent = `Survey · ${S.model.meta.n_samples.toLocaleString()} readings`;
  else if (S.source === 'live') { dp.classList.add(r && r.age_s < ROBOT_ONLINE_S ? 'on' : 'warn'); $('dataPillText').textContent = `Live · ${S.live.samples.length.toLocaleString()} readings`; }
  else { dp.classList.add(S.replay.timer ? 'on' : 'warn'); $('dataPillText').textContent = `Replay · ${S.replay.idx}/${replayQueue ? replayQueue.length : 0} scan points`; }

  $('liveBadge').textContent = S.source === 'baseline' ? 'survey order' : S.source === 'replay' ? (S.replay.timer ? 'replaying' : 'done') : (r && r.age_s < ROBOT_ONLINE_S ? 'live' : 'waiting');
}
function ago(s) { s = Math.round(s); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; }

// ======================================================
//  COLOUR SCALES
// ======================================================
const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  return `rgb(${stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * u))})`;
}
const MAGMA = [[252, 253, 191], [252, 137, 97], [183, 55, 121], [81, 18, 124], [0, 0, 4]];
// Signal domain spans the observed range so a 15 dB difference uses most of the scale
function signalDomain() {
  const vals = S.model.cells.map((c) => c.rssi_best_mean).concat(S.cells.map((c) => c.rssi_best_mean));
  return [Math.floor(Math.min(...vals)), Math.ceil(Math.max(...vals))];
}
const CLUSTER_COLORS = ['#00b894', '#81ecec', '#74b9ff', '#6c5ce7', '#e17055'];

function layerInfo() {
  const [lo, hi] = signalDomain();
  const contMax = Math.max(1, ...S.model.cells.map((c) => c.contention));
  const stdMax = Math.max(1, ...S.model.cells.map((c) => c.rssi_spatial_std || 0));
  const gpStdMax = Math.max(...S.model.gp.flatMap((g) => g.points.map((p) => p[3])));
  return {
    signal: { color: (c) => ramp(VIRIDIS, (c.rssi_best_mean - lo) / (hi - lo)), lo, hi, unit: 'dBm', scale: VIRIDIS, title: 'best-AP signal (dBm)' },
    gp: { lo, hi, unit: 'dBm', scale: VIRIDIS, title: 'GP-interpolated signal (dBm)' },
    uncertainty: { lo: 0, hi: gpStdMax, unit: 'dB σ', scale: MAGMA, title: 'GP predictive std (uncertainty)' },
    contention: { color: (c) => c.contention == null ? null : ramp(MAGMA, c.contention / contMax), lo: 0, hi: contMax, unit: 'co-channel APs', scale: MAGMA, title: 'channel contention' },
    variability: { color: (c) => c.rssi_spatial_std == null ? null : ramp(MAGMA, c.rssi_spatial_std / stdMax), lo: 0, hi: stdMax, unit: 'dB spatial std', scale: MAGMA, title: 'signal variability' },
    cluster: { color: (c) => CLUSTER_COLORS[c.cluster], title: 'cluster & recommended action' },
  }[S.layer];
}

// ======================================================
//  FLOOR MAP
// ======================================================
const map = $('mapCanvas'), mctx = map.getContext('2d');
let view = null;

function floorExtent() {
  const f = S.floor;
  const es = [], ns = [];
  for (const c of S.model.cells.concat(S.cells)) if (c.floor === f) { es.push(c.e); ns.push(c.n); }
  for (const a of S.model.aps) if (a.floor_est === f) { es.push(a.centroid_e); ns.push(a.centroid_n); }
  if (S.show.truth) for (const a of S.model.aps) if (a.true_floor === f) { es.push(a.true_e); ns.push(a.true_n); }
  if (!es.length) return { e0: 40, e1: 60, n0: 10, n1: 75 };
  return { e0: Math.min(...es) - 3, e1: Math.max(...es) + 3, n0: Math.min(...ns) - 3, n1: Math.max(...ns) + 3 };
}

function drawMap() {
  const dpr = window.devicePixelRatio || 1;
  const ext = floorExtent();
  const W = map.clientWidth;
  const pad = { l: 58, r: 16, t: 12, b: 40 };
  const s = (W - pad.l - pad.r) / (ext.n1 - ext.n0);
  const H = Math.max(220, Math.min(560, s * (ext.e1 - ext.e0) + pad.t + pad.b));
  const sY = Math.min(s, (H - pad.t - pad.b) / (ext.e1 - ext.e0)); // equal metres on both axes
  map.width = W * dpr; map.height = H * dpr; map.style.height = H + 'px';
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sc = Math.min(s, sY);
  const ox = pad.l + ((W - pad.l - pad.r) - sc * (ext.n1 - ext.n0)) / 2;
  const oy = pad.t + ((H - pad.t - pad.b) - sc * (ext.e1 - ext.e0)) / 2;
  const X = (n) => ox + (n - ext.n0) * sc, Y = (e) => oy + (ext.e1 - e) * sc;
  view = { X, Y, s: sc };

  mctx.fillStyle = css('--bg'); mctx.fillRect(0, 0, W, H);

  // axes
  const step = (ext.n1 - ext.n0) > 40 ? 10 : 5;
  mctx.strokeStyle = css('--border'); mctx.lineWidth = 1; mctx.fillStyle = css('--text2');
  mctx.font = '10px "DM Sans",system-ui'; mctx.textAlign = 'center';
  for (let n = Math.ceil(ext.n0 / step) * step; n <= ext.n1; n += step) {
    mctx.beginPath(); mctx.moveTo(X(n), Y(ext.e1)); mctx.lineTo(X(n), Y(ext.e0)); mctx.stroke();
    mctx.fillText(n, X(n), Y(ext.e0) + 13);
  }
  mctx.textAlign = 'right';
  const estep = (ext.e1 - ext.e0) > 25 ? 10 : (ext.e1 - ext.e0) > 12 ? 4 : 2;
  for (let e = Math.ceil(ext.e0 / estep) * estep; e <= ext.e1; e += estep) {
    mctx.beginPath(); mctx.moveTo(X(ext.n0), Y(e)); mctx.lineTo(X(ext.n1), Y(e)); mctx.stroke();
    mctx.fillText(e, X(ext.n0) - 6, Y(e) + 3);
  }
  mctx.font = '600 11px "DM Sans",system-ui'; mctx.textAlign = 'center';
  mctx.fillText('North, N (m)', X((ext.n0 + ext.n1) / 2), H - 6);
  mctx.save(); mctx.translate(14, Y((ext.e0 + ext.e1) / 2)); mctx.rotate(-Math.PI / 2); mctx.fillText('East, E (m)', 0, 0); mctx.restore();

  const L = layerInfo();
  if (S.layer === 'gp' || S.layer === 'uncertainty') {
    const g = S.model.gp.find((x) => x.floor === S.floor);
    const sz = g ? g.step * sc + 0.5 : 0;
    for (const [e, n, m, sd] of g ? g.points : []) {
      mctx.fillStyle = S.layer === 'gp' ? ramp(L.scale, (m - L.lo) / (L.hi - L.lo)) : ramp(L.scale, sd / L.hi);
      mctx.fillRect(X(n) - sz / 2, Y(e) - sz / 2, sz, sz);
    }
    // measured cells as outlines on top of the surface
    mctx.strokeStyle = 'rgba(255,255,255,.7)'; mctx.lineWidth = 1;
    for (const c of S.cells) if (c.floor === S.floor) { const z = 2 * sc - 3; mctx.strokeRect(X(c.n) - z / 2, Y(c.e) - z / 2, z, z); }
  } else {
    const size = Math.max(4, 2 * sc - 2);
    for (const c of S.cells) {
      if (c.floor !== S.floor) continue;
      const col = L.color(c);
      roundRect(X(c.n) - size / 2, Y(c.e) - size / 2, size, size, 3);
      if (col) { mctx.fillStyle = col; mctx.fill(); }
      else { mctx.strokeStyle = css('--text3'); mctx.lineWidth = 1; mctx.stroke(); }
    }
  }
  if (!S.cells.some((c) => c.floor === S.floor) && S.layer !== 'gp' && S.layer !== 'uncertainty') {
    mctx.fillStyle = css('--text2'); mctx.font = '600 13px "DM Sans"'; mctx.textAlign = 'center';
    mctx.fillText(S.source === 'live' ? 'Waiting for the robot to scan this floor…' : 'No scan data on this floor yet', W / 2, H / 2);
  }

  // scan points (actual robot measurement locations); chronological path for live/replay
  if (S.show.path) {
    const pts = currentPoints().filter((p) => p.floor === S.floor);
    if (S.source !== 'baseline' && pts.length > 1) {
      mctx.strokeStyle = 'rgba(232,67,147,.6)'; mctx.lineWidth = 1.5; mctx.beginPath();
      pts.forEach((p, i) => i ? mctx.lineTo(X(p.n), Y(p.e)) : mctx.moveTo(X(p.n), Y(p.e))); mctx.stroke();
    }
    mctx.fillStyle = css('--text');
    for (const p of pts) { mctx.beginPath(); mctx.arc(X(p.n), Y(p.e), 1.4, 0, Math.PI * 2); mctx.fill(); }
  }

  // ground truth + error vectors (estimate -> truth)
  if (S.show.truth) {
    for (const ap of S.model.aps) {
      if (ap.true_floor !== S.floor) continue;
      if (ap.floor_est === S.floor) {
        mctx.strokeStyle = css('--red'); mctx.lineWidth = 1.2; mctx.setLineDash([2, 2]); mctx.beginPath();
        mctx.moveTo(X(ap.centroid_n), Y(ap.centroid_e)); mctx.lineTo(X(ap.true_n), Y(ap.true_e)); mctx.stroke(); mctx.setLineDash([]);
      }
      const x = X(ap.true_n), y = Y(ap.true_e);
      mctx.strokeStyle = css('--text'); mctx.lineWidth = 2; mctx.beginPath();
      mctx.moveTo(x - 4, y - 4); mctx.lineTo(x + 4, y + 4); mctx.moveTo(x + 4, y - 4); mctx.lineTo(x - 4, y + 4); mctx.stroke();
    }
  }
  if (S.show.aps) {
    for (const ap of S.model.aps) {
      if (ap.floor_est !== S.floor) continue;
      const x = X(ap.centroid_n), y = Y(ap.centroid_e);
      mctx.beginPath(); mctx.arc(x, y, 6, 0, Math.PI * 2);
      mctx.fillStyle = '#fff'; mctx.fill(); mctx.strokeStyle = css('--pink'); mctx.lineWidth = 2.5; mctx.stroke();
      mctx.fillStyle = css('--text'); mctx.font = 'bold 9px "DM Sans"'; mctx.textAlign = 'center';
      mctx.fillText('AP' + ap.ap_id, x, y - 9);
    }
  }

  if (S.robot && S.robot.floor === S.floor) {
    const x = X(S.robot.n), y = Y(S.robot.e), a = -((S.robot.heading || 0) * Math.PI / 180);
    mctx.beginPath(); mctx.arc(x, y, 16 + Math.sin(Date.now() / 300) * 3, 0, Math.PI * 2);
    mctx.strokeStyle = 'rgba(232,67,147,.4)'; mctx.lineWidth = 2; mctx.stroke();
    mctx.save(); mctx.translate(x, y); mctx.rotate(a);
    mctx.beginPath(); mctx.moveTo(11, 0); mctx.lineTo(-7, -7); mctx.lineTo(-7, 7); mctx.closePath();
    mctx.fillStyle = css('--pink'); mctx.fill(); mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.stroke();
    mctx.restore();
  }
}
function roundRect(x, y, w, h, r) {
  mctx.beginPath(); mctx.moveTo(x + r, y); mctx.arcTo(x + w, y, x + w, y + h, r); mctx.arcTo(x + w, y + h, x, y + h, r);
  mctx.arcTo(x, y + h, x, y, r); mctx.arcTo(x, y, x + w, y, r); mctx.closePath();
}

function renderLegend() {
  const L = layerInfo();
  let body;
  if (S.layer === 'cluster') {
    body = S.model.cluster_model.clusters.map((c) =>
      `<span class="legend-item"><span class="sw" style="background:${CLUSTER_COLORS[c.cluster]}"></span>C${c.cluster} ${esc(c.name)} → ${esc(c.action)}</span>`).join('');
  } else {
    const grad = [0, .25, .5, .75, 1].map((t) => ramp(L.scale, t)).join(',');
    body = `<span>${fmt(L.lo, L.lo % 1 ? 1 : 0)}</span><span class="ramp" style="background:linear-gradient(90deg,${grad})"></span><span>${fmt(L.hi, L.hi % 1 ? 1 : 0)} ${L.unit}</span>`;
    if (S.layer === 'gp' || S.layer === 'uncertainty') body += `<span class="legend-item">□ measured cells · GP fit on survey cells</span>`;
    if (S.layer === 'contention' || S.layer === 'variability') body += `<span class="legend-item"><span class="sw" style="border:1px solid var(--text3)"></span>no value</span>`;
  }
  const extra = `<span class="legend-item"><span class="sw" style="border:2.5px solid var(--pink);border-radius:50%;background:#fff"></span>AP (centroid estimate)</span>`
    + (S.show.path ? `<span class="legend-item">• scan point${S.source !== 'baseline' ? ' / robot path' : ''}</span>` : '')
    + (S.show.truth ? `<span class="legend-item">✕ true AP · <span style="color:var(--red)">┄</span> localisation error</span>` : '')
    + (S.robot ? `<span class="legend-item"><span class="sw" style="background:var(--pink);clip-path:polygon(0 0,100% 50%,0 100%)"></span>robot</span>` : '');
  $('mapLegend').innerHTML = body + `<span style="margin-left:auto;display:flex;gap:.9rem;flex-wrap:wrap">${extra}</span>`;
  $('mapTitle').textContent = `Floor ${S.floor} — ${L.title}`;
}

map.addEventListener('mousemove', (e) => {
  if (!view) return;
  const r = map.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const tip = $('mapTip');
  const ap = S.show.aps && S.model.aps.find((a) => a.floor_est === S.floor && Math.hypot(view.X(a.centroid_n) - mx, view.Y(a.centroid_e) - my) < 9);
  let html = '';
  if (ap) {
    html = `<b>AP ${ap.ap_id}</b> · ${esc(ap.macs.join(', '))} · ${esc(ap.band)}<br>Centroid estimate: (${fmt(ap.centroid_e)} E, ${fmt(ap.centroid_n)} N), floor ${ap.floor_est}<br>
      Error vs ground truth: ${fmt(ap.centroid_err_2d_m)} m (NLS: ${fmt(ap.nls_joint_err_2d_m)} m)<br>${ap.n_detections} detections`;
  } else {
    const half = view.s;
    const c = S.cells.find((c) => c.floor === S.floor && Math.abs(view.X(c.n) - mx) <= half && Math.abs(view.Y(c.e) - my) <= half);
    const g = (S.layer === 'gp' || S.layer === 'uncertainty') && S.model.gp.find((x) => x.floor === S.floor)?.points
      .find((p) => Math.abs(view.X(p[1]) - mx) <= view.s / 2 && Math.abs(view.Y(p[0]) - my) <= view.s / 2);
    if (c) {
      const sv = c.featureSource === 'survey' ? ' <span style="color:var(--text3)">(survey)</span>' : '';
      html = `<b>Cell (${fmt(c.e)} E, ${fmt(c.n)} N)</b> · floor ${c.floor}<br>
        Best AP: ${fmt(c.rssi_best_mean)} dBm · all-AP mean ${fmt(c.rssi_all_mean)} dBm<br>
        Visible networks: ${fmt(c.n_aps_visible)}${sv} · best–2nd gap ${fmt(c.best_second_gap)} dB<br>
        Contention: ${fmt(c.contention)}${sv}${c.contention_projected_1_6_11 != null ? ` → ${fmt(c.contention_projected_1_6_11)} on ch 1/6/11` : ''}<br>
        Spatial std: ${c.rssi_spatial_std != null ? fmt(c.rssi_spatial_std) + ' dB' : '– (1 scan point)'} · ${c.n_samples} scan point${c.n_samples === 1 ? '' : 's'}<br>
        Cluster C${c.cluster}: ${esc(c.cluster_name)}<br>Action: <b>${esc(c.action)}</b>`;
    } else if (g) {
      html = `<b>GP at (${g[0]} E, ${g[1]} N)</b><br>Predicted best-AP RSSI: ${fmt(g[2])} dBm<br>Uncertainty (σ): ±${fmt(g[3], 2)} dB`;
    }
  }
  if (!html) { tip.classList.remove('visible'); return; }
  tip.innerHTML = html;
  const left = mx + 16 + 300 > r.width ? mx - 310 : mx + 16;
  tip.style.left = Math.max(0, left) + 'px'; tip.style.top = Math.max(0, my - 10) + 'px';
  tip.classList.add('visible');
});
map.addEventListener('mouseleave', () => $('mapTip').classList.remove('visible'));

// ======================================================
//  RESULTS (building-wide pipeline findings)
// ======================================================
function renderResults() {
  const M = S.model;
  const cov = M.coverage_vs_ap, nApsCov = cov.length;
  const k100 = cov.find((r) => r.coverage_pct >= 99.95), k90 = cov.find((r) => r.coverage_pct >= 90);
  const flagged = M.cells.filter((c) => c.action !== 'no action').length;
  const gaps = M.cells.filter((c) => c.action.startsWith('coverage')).length;
  const sb = M.benchmark.filter((b) => b.strategy === 'c_spatial_block');
  const get = (k) => sb.find((b) => b.model.includes(k));
  const hy = get('hybrid'), ph = get('physics'), nv = get('naive');
  const both = M.cells.filter((c) => c.contention != null && c.contention_projected_1_6_11 != null);
  const card = (head, val, sub) => `<div class="stat"><div class="stat-head">${head}</div><div class="stat-value">${val}</div><div class="stat-sub">${sub}</div></div>`;
  $('results').innerHTML =
    card('AP coverage', `${k100.k} of ${nApsCov} APs`, `cover 100% of ${k100.n_covered} scan points · ${k90.k} reach 90%`) +
    card('Redundant APs', nApsCov - k100.k, 'add no coverage once the first ' + k100.k + ' are on') +
    card('Cells flagged', `${pct(flagged, M.cells.length)}%`, `${flagged}/${M.cells.length} cells: small-scale fading, ${gaps} coverage gaps`) +
    card('Channel plan', `${fmt(mean(both.map((c) => c.contention)))} → ${fmt(mean(both.map((c) => c.contention_projected_1_6_11)))}`, 'mean contention if APs move to ch 1/6/11') +
    card('AP localisation', `${fmt(median(M.aps.map((a) => a.centroid_err_2d_m)))} m`, `median centroid error · ${pct(M.aps.filter((a) => a.floor_correct).length, M.aps.length)}% correct floor`) +
    card('RSSI prediction', `${fmt(hy.mean, 2)} dB`, `hybrid RMSE (unseen areas) vs physics ${fmt(ph.mean, 2)} · naive ${fmt(nv.mean, 2)}`);
}

function renderFloorStats() {
  const cells = S.cells.filter((c) => c.floor === S.floor);
  const best = cells.map((c) => c.rssi_best_mean);
  const flagged = cells.filter((c) => c.action !== 'no action').length;
  const cont = cells.map((c) => c.contention).filter((x) => x != null);
  const g = S.model.gp.find((x) => x.floor === S.floor);
  const src = { baseline: 'survey', live: 'live', replay: 'replay' }[S.source];
  const card = (val, label, sub) => `<div class="stat"><div class="stat-value">${val}</div><div class="stat-label">${label}</div><div class="stat-sub">${sub}</div></div>`;
  $('floorStats').innerHTML =
    card(fmt(mean(best)), 'Avg best RSSI (dBm)', `floor ${S.floor} · ${src}`) +
    card(best.length ? `${fmt(Math.min(...best), 0)} … ${fmt(Math.max(...best), 0)}` : '–', 'Signal range (dBm)', best.length ? `${fmt(Math.max(...best) - Math.min(...best))} dB spread` : '') +
    card(cells.length, 'Cells mapped', `of ${S.model.cellsByFloor.get(S.floor)?.length || 0} survey cells on floor`) +
    card(cells.length ? `${pct(flagged, cells.length)}%` : '–', 'Cells needing action', `${flagged} cells`) +
    card(fmt(mean(cont)), 'Avg contention', cont.length ? 'co-channel APs per cell' : 'needs channel data') +
    card(g ? `±${fmt(mean(g.points.map((p) => p[3])), 2)}` : '–', 'GP uncertainty (dB)', 'mean predictive σ, survey');
}

function renderApTable() {
  const aps = [...S.model.aps].sort((a, b) => (b.floor_est === S.floor) - (a.floor_est === S.floor) || a.floor_est - b.floor_est || a.ap_id - b.ap_id);
  $('apBadge').textContent = `${aps.length} APs · ${S.model.meta.n_macs} BSSIDs`;
  $('apTable').innerHTML = `<table><thead><tr><th>AP</th><th>BSSIDs</th><th class="num">Floor</th><th class="num">E, N (m)</th><th class="num">Centroid err</th><th class="num">NLS err</th><th class="num">Hits</th></tr></thead><tbody>` +
    aps.map((a) => {
      const err = a.centroid_err_2d_m, cls = err < 3 ? 'good' : err < 8 ? 'warn' : 'bad';
      return `<tr style="${a.floor_est === S.floor ? '' : 'opacity:.5'}"><td><b>AP${a.ap_id}</b></td><td style="font-family:var(--mono);font-size:.7rem">${esc(a.macs.join(' '))}</td>
        <td class="num">${a.floor_est}${a.floor_correct ? '' : ' ⚠'}</td><td class="num">${fmt(a.centroid_e)}, ${fmt(a.centroid_n)}</td>
        <td class="num"><span class="tag ${cls}">${fmt(err)} m</span></td><td class="num">${fmt(a.nls_joint_err_2d_m)} m</td><td class="num">${a.n_detections}</td></tr>`;
    }).join('') + '</tbody></table>';
}

function renderSummary() {
  const M = S.model;
  const cells = S.cells.filter((c) => c.floor === S.floor);
  const srcName = { baseline: 'recorded survey', live: 'live robot session', replay: 'survey replay' }[S.source];
  if (!cells.length) { $('summary').innerHTML = `<div class="sblock"><h4>Floor ${S.floor}</h4><p>No ${srcName} data on this floor yet.</p></div>`; return; }
  const best = cells.map((c) => c.rssi_best_mean);
  const byCluster = M.cluster_model.clusters.map((c) => ({ ...c, here: cells.filter((x) => x.cluster === c.cluster) }));
  const rough = cells.filter((c) => c.action.startsWith('small-scale'));
  const gaps = cells.filter((c) => c.action.startsWith('coverage'));
  const both = cells.filter((c) => c.contention != null && c.contention_projected_1_6_11 != null);
  const cov = M.coverage_vs_ap, k100 = cov.find((r) => r.coverage_pct >= 99.95);
  const keep = cov.slice(0, k100.k).map((r) => 'AP' + r.ap_added);
  const worst = [...rough].sort((a, b) => (b.rssi_spatial_std || 0) - (a.rssi_spatial_std || 0)).slice(0, 3);
  const sb = M.benchmark.filter((b) => b.strategy === 'c_spatial_block').sort((a, b) => a.mean - b.mean);
  const nv = sb.find((b) => b.model.includes('naive')), ph = sb.find((b) => b.model.includes('physics'));

  const recs = [];
  recs.push(gaps.length
    ? `<span class="bad">${gaps.length}</span> coverage-gap cell(s) — add or move an AP.`
    : `<span class="good">No coverage gaps:</span> every cell's strongest AP is between ${fmt(Math.min(...best), 0)} and ${fmt(Math.max(...best), 0)} dBm.`);
  if (rough.length) recs.push(`<span class="hl">${rough.length}/${cells.length}</span> cells (${pct(rough.length, cells.length)}%) are “strong rough”: the signal is strong but fluctuates over short distances. That is a siting / multipath problem, not coverage — reorient or relocate the nearest AP rather than adding one. Worst at ${worst.map((c) => `(${fmt(c.e, 0)} E, ${fmt(c.n, 0)} N, σ ${fmt(c.rssi_spatial_std)} dB)`).join(', ')}.`);
  if (both.length) recs.push(`Moving 2.4 GHz APs to channels 1/6/11 lowers mean contention on this floor from <span class="warn">${fmt(mean(both.map((c) => c.contention)))}</span> to <span class="good">${fmt(mean(both.map((c) => c.contention_projected_1_6_11)))}</span> (same ${both.length} cells).`);
  recs.push(`Building-wide, ${keep.join(', ')} alone cover every scan point; the other <span class="warn">${cov.length - k100.k}</span> APs could be switched off or re-channelled to reduce contention.`);

  $('summary').innerHTML = `
    <div class="sblock"><h4>Floor ${S.floor} at a glance</h4>
      <p>From the ${srcName}: ${cells.length} cells, best-AP signal averages <span class="hl">${fmt(mean(best))} dBm</span>
      (range ${fmt(Math.min(...best))} to ${fmt(Math.max(...best))} dBm).</p>
      <ul>${byCluster.filter((c) => c.here.length).map((c) => `<li><span class="sw" style="background:${CLUSTER_COLORS[c.cluster]};display:inline-block;vertical-align:middle"></span>
        C${c.cluster} ${esc(c.name)}: <b>${c.here.length}</b> cells (${pct(c.here.length, cells.length)}%) — ${esc(c.action)}</li>`).join('')}</ul></div>
    <div class="sblock"><h4>Recommendations</h4><ul>${recs.map((r) => `<li>${r}</li>`).join('')}</ul></div>
    <div class="sblock"><h4>Access points</h4>
      <p>${M.aps.filter((a) => a.floor_est === S.floor).length} APs are localised on this floor. The RSSI-weighted centroid places APs with a median error of
      <span class="hl">${fmt(median(M.aps.map((a) => a.centroid_err_2d_m)))} m</span>, compared with ${fmt(median(M.aps.map((a) => a.nls_joint_err_2d_m)))} m for joint NLS
      and ${fmt(median(M.aps.map((a) => a.centre_err_2d_m)))} m for a building-centre guess.</p></div>
    <div class="sblock"><h4>Prediction model</h4>
      <p>On unseen areas (spatial-block CV) the <span class="good">${esc(sb[0].model.replace(/^\d\.\s*/, ''))}</span> model predicts RSSI within
      <span class="hl">${fmt(sb[0].mean, 2)} dB</span> RMSE, versus ${fmt(ph.mean, 2)} dB for the physics model alone and ${fmt(nv.mean, 2)} dB for the naive train-fold mean.
      Distance and AP position dominate the learned correction.</p></div>`;
  $('summaryTime').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

// ======================================================
//  CHARTS
// ======================================================
const charts = {};
function chartDefaults() {
  Chart.defaults.font.family = '"DM Sans",system-ui'; Chart.defaults.font.size = 11;
  Chart.defaults.color = css('--text2'); Chart.defaults.borderColor = css('--border');
}
function makeChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const o = cfg.options || {};
  cfg.options = { responsive: true, maintainAspectRatio: false, animation: false, ...o, plugins: { legend: { display: false }, ...o.plugins } };
  charts[id] = new Chart($(id), cfg);
}
const axis = (text) => ({ display: true, text, font: { weight: 600 } });

// draws horizontal/vertical reference lines: lines = [{y|x, label, color}]
const refLines = {
  id: 'refLines',
  afterDatasetsDraw(chart, _, opts) {
    const { ctx, chartArea: a, scales } = chart;
    for (const l of opts.lines || []) {
      ctx.save(); ctx.strokeStyle = l.color; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.beginPath();
      if (l.y != null) { const y = scales.y.getPixelForValue(l.y); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); }
      else { const x = scales.x.getPixelForValue(l.x); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); }
      ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = l.color; ctx.font = '600 10px "DM Sans"';
      if (l.y != null) { ctx.textAlign = 'right'; ctx.fillText(l.label, a.right - 4, scales.y.getPixelForValue(l.y) - 4); }
      else { ctx.textAlign = 'left'; ctx.fillText(l.label, scales.x.getPixelForValue(l.x) + 4, a.bottom - 6); }
      ctx.restore();
    }
  },
};

function renderStaticCharts() {
  chartDefaults();
  const B = S.model.benchmark;
  const models = [...new Set(B.map((b) => b.model))].sort();
  const strategies = [['a_random_point', 'Random points'], ['b_groupkfold_by_ap', 'Unseen APs'], ['c_spatial_block', 'Unseen areas']];
  const palette = ['#b8a5c2', '#fd79a8', '#74b9ff', '#e09100', '#00b894'];
  makeChart('benchChart', {
    type: 'bar',
    data: { labels: strategies.map((s) => s[1]), datasets: models.map((m, i) => ({
      label: m.replace(/^\d\.\s*/, ''), backgroundColor: palette[i], borderRadius: 4,
      data: strategies.map(([s]) => B.find((b) => b.strategy === s && b.model === m)?.mean),
    })) },
    options: {
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10 } },
        tooltip: { callbacks: { label: (c) => { const b = B.find((x) => x.strategy === strategies[c.dataIndex][0] && x.model === models[c.datasetIndex]); return `${c.dataset.label}: ${fmt(b.mean, 2)} ± ${fmt(b.std, 2)} dB`; } } } },
      scales: { y: { title: axis('RMSE (dB)'), beginAtZero: true }, x: { title: axis('Validation strategy') } },
    },
  });

  const cov = S.model.coverage_vs_ap;
  const k100 = cov.find((r) => r.coverage_pct >= 99.95), k90 = cov.find((r) => r.coverage_pct >= 90);
  $('covBadge').textContent = `${k100.k} APs → 100%`;
  makeChart('covChart', {
    type: 'line',
    data: { labels: cov.map((r) => r.k), datasets: [{ data: cov.map((r) => r.coverage_pct), borderColor: css('--pink'), backgroundColor: 'rgba(232,67,147,.12)', fill: true, tension: 0, pointRadius: 3 }] },
    plugins: [refLines],
    options: {
      plugins: {
        refLines: { lines: [{ y: 90, label: `90% target (${k90.k} APs)`, color: '#e09100' }, { y: 100, label: 'full coverage', color: '#00b894' }, { x: k100.k - 1, label: `k = ${k100.k}`, color: '#00b894' }] },
        tooltip: { callbacks: { label: (c) => `${fmt(c.parsed.y)}% of scan points (${cov[c.dataIndex].n_covered}) · adds AP${cov[c.dataIndex].ap_added}` } },
      },
      scales: { x: { title: axis('Number of APs kept (greedy order)') }, y: { min: 0, max: 105, ticks: { callback: (v) => v <= 100 ? v + '%' : '' }, title: axis('Scan points covered') } },
    },
  });

  const fi = [...S.model.feature_importance].sort((a, b) => b.importance - a.importance);
  makeChart('featChart', {
    type: 'bar',
    data: { labels: fi.map((f) => f.feature), datasets: [{ data: fi.map((f) => f.importance * 100), backgroundColor: css('--pink'), borderRadius: 4 }] },
    options: { indexAxis: 'y', scales: { x: { title: axis('Importance (%)') }, y: { title: axis('Feature') } } },
  });

  const rh = S.model.residual_hist;
  $('residSub').textContent = `Measured − physics-predicted RSSI, ${S.model.meta.n_samples.toLocaleString()} readings · mean ${fmt(rh.mean, 2)} dB · RMSE ${fmt(rh.rmse, 2)} dB`;
  makeChart('residChart', {
    type: 'bar',
    data: { labels: rh.counts.map((_, i) => `${rh.edges[i]} to ${rh.edges[i + 1]}`), datasets: [{ data: rh.counts, backgroundColor: css('--pink'), borderRadius: 2, barPercentage: 1, categoryPercentage: .96 }] },
    options: { scales: { x: { title: axis('Residual (dB)'), ticks: { callback: (_, i) => rh.edges[i] } }, y: { title: axis('Number of readings') } } },
  });
}

function renderSignalChart() {
  const pts = currentPoints();
  const recent = S.source === 'baseline' ? [] : pts.slice(-150);
  const [lo, hi] = signalDomain();
  if (!charts.signalChart) {
    makeChart('signalChart', {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: css('--pink'), backgroundColor: 'rgba(232,67,147,.12)', fill: true, tension: .2, pointRadius: 0, borderWidth: 2 }] },
      options: { scales: { y: { title: axis('Best-AP RSSI (dBm)') }, x: { title: axis('Scan point'), ticks: { maxTicksLimit: 8 } } }, plugins: { tooltip: {} } },
    });
  }
  const ch = charts.signalChart;
  ch.options.scales.y.min = Math.min(lo, ...recent.map((p) => p.best)) - 2;
  ch.options.scales.y.max = Math.max(hi, ...recent.map((p) => p.best)) + 2;
  ch.options.scales.x.title.text = S.source === 'live' ? 'Time' : 'Scan point';
  ch.data.labels = recent.map((p, i) => (S.source === 'live' && p.t) ? new Date(p.t).toLocaleTimeString() : '#' + (pts.length - recent.length + i + 1));
  ch.data.datasets[0].data = recent.map((p) => p.best);
  ch.options.plugins.tooltip.callbacks = { title: (c) => { const p = recent[c[0].dataIndex]; return p ? `Floor ${p.floor} · (${p.e} E, ${p.n} N)` : ''; } };
  ch.update('none');
}

function pushFeed(rows) {
  const feed = $('feed');
  if (feed.children.length === 1 && feed.firstElementChild.classList.contains('t')) feed.innerHTML = '';
  const byPoint = new Map();
  for (const r of rows) {
    const k = `${r.floor}|${r.e}|${r.n}`;
    const p = byPoint.get(k) || { ...r, macs: new Set(), best: -200, bestMac: '' };
    p.macs.add(r.mac); if (r.rssi > p.best) { p.best = r.rssi; p.bestMac = r.ssid || r.mac; }
    byPoint.set(k, p);
  }
  const [lo, hi] = signalDomain();
  for (const p of byPoint.values()) {
    const div = document.createElement('div');
    const t = p.t ? new Date(p.t).toLocaleTimeString() : '';
    div.innerHTML = `<span class="t">${t}</span> F${p.floor} (${fmt(p.e)}, ${fmt(p.n)}) · ${p.macs.size} BSSIDs · best <b>${p.best.toFixed(0)} dBm</b> ${esc(p.bestMac)}`;
    feed.prepend(div);
  }
  while (feed.children.length > 60) feed.lastChild.remove();
}

// ======================================================
//  CONTROLS & MAIN LOOP
// ======================================================
function selectFloor(f) {
  S.floor = f;
  document.querySelectorAll('#floorSeg .btn').forEach((b) => b.classList.toggle('active', +b.dataset.floor === f));
}
function toggleOpt(k, btn) { S.show[k] = !S.show[k]; btn.classList.toggle('active', S.show[k]); renderLegend(); drawMap(); }

document.querySelectorAll('#sourceSeg .btn').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));
document.querySelectorAll('#layerSeg .btn').forEach((b) => b.addEventListener('click', () => {
  S.layer = b.dataset.layer;
  document.querySelectorAll('#layerSeg .btn').forEach((x) => x.classList.toggle('active', x === b));
  renderLegend(); drawMap();
}));

let summaryAt = 0;
function refresh(force) {
  S.cells = currentCells();
  renderFloorStats(); renderApTable(); renderLegend(); drawMap(); renderSignalChart(); renderStatus();
  if (force || Date.now() - summaryAt > 2000) { summaryAt = Date.now(); renderSummary(); }
}
function renderAll() { renderStaticCharts(); if (charts.signalChart) { charts.signalChart.destroy(); delete charts.signalChart; } refresh(true); }

(function animateRobot() { if (S.robot) drawMap(); setTimeout(() => requestAnimationFrame(animateRobot), 60); })();
window.addEventListener('resize', () => drawMap());

async function init() {
  const name = localStorage.getItem('userName');
  if (name) $('userGreeting').textContent = 'Hi, ' + name;
  try {
    S.model = await (await fetch('data/gridsense.json')).json();
  } catch (err) {
    $('dataPillText').textContent = 'Failed to load model data';
    return;
  }
  S.model.cellsByFloor = new Map();
  S.model.cells.forEach((c, idx) => {
    c.idx = idx;
    if (!S.model.cellsByFloor.has(c.floor)) S.model.cellsByFloor.set(c.floor, []);
    S.model.cellsByFloor.get(c.floor).push(c);
  });
  $('floorSeg').innerHTML = S.model.meta.floors.map((f) => `<button class="btn" data-floor="${f}">F${f}</button>`).join('');
  document.querySelectorAll('#floorSeg .btn').forEach((b) => b.addEventListener('click', () => { selectFloor(+b.dataset.floor); refresh(true); }));
  selectFloor(S.model.meta.floors[0]);
  renderResults();
  renderStaticCharts();
  refresh(true);
  pollLive();
  setInterval(pollLive, POLL_MS);
}
init();
