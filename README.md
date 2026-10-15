# GridSense — WiFi Signal Mapping Robot

Dashboard for the GridSense robot: it maps WiFi signal strength floor by floor, localises access points,
flags problem areas and shows how well our RSSI prediction models perform.

## Data sources (toolbar → "Data source")

| Mode | What it shows |
|------|---------------|
| **Survey model** | Output of the analysis pipeline on the recorded survey (`data/gridsense.json`): per-cell signal, contention, variability, cluster/action, AP position estimates, ML benchmark, coverage-vs-AP curve. |
| **Live robot** | Readings the robot is posting right now. The page polls `/api/live` every 3 s and rebuilds the map from the database. Switches on automatically when a robot heartbeat is less than 30 s old. |
| **Replay survey** | Streams the recorded readings through the same live aggregation in the browser, for demos without the robot. |

## Robot → website API

`POST /api/ingest` with header `x-api-key: <ROBOT_API_KEY>`:

```json
{
  "device_id": "gridsense-bot-1",
  "session_id": "2026-10-14-run1",
  "pose": { "floor": 1, "e": 52.0, "n": 31.4, "heading": 90, "speed": 0.35, "battery": 87 },
  "readings": [ { "mac": "AA:BB:CC:DD:EE:01", "ssid": "Campus", "rssi": -48, "band": "2.4GHz", "channel": 6 } ]
}
```

Optional navigation telemetry (shown in the **Robot health** card — sensor status, events, stuck detection):

```json
"telemetry": { "state": "EXPLORE", "event": "FRONT OBSTACLE", "sensors": [-1, 643, 963, -1, 1031, -1],
               "wheel_l_cm": 120.4, "wheel_r_cm": 118.9 }
```

If the robot only knows its odometry position (x/y from where it started, as in the exploration logs),
send it in the robot frame and the server converts it to the survey's E/N metres:

```json
"pose": { "frame": "local", "x": 4.12, "y": -1.13, "heading": -104,
          "origin": { "floor": 1, "e": 52.0, "n": 15.0, "theta": 0 } }
```

`origin` is the robot's start point on the survey map; `theta` is the direction of the robot's +x axis in
degrees counter-clockwise from North towards East.

Send one request per scan stop (or an empty `readings` array as a heartbeat). Positions are metres in the
same E/N frame as the survey. Tables (`scans`, `robot_status`) are created automatically in the Neon database.

`GET /api/live?since=<id>&session=<id>` (logged-in user) returns robot status, sessions and new scans.

## Exploration logs

The **Exploration runs** card analyses the robot's `exploration_*.csv` navigation logs: path, turns,
obstacles, spinning-in-place detection, turn accuracy, heading drift and distance-sensor health.
Logs in `data/runs/` (listed in `data/runs/index.json`) load automatically; others can be uploaded in the browser.

## Setup

Vercel environment variables: `DATABASE_URL` (Neon), `JWT_SECRET`, `ROBOT_API_KEY` (any long random string; the same value goes on the robot).

Test the live pipeline without the robot:

```bash
ROBOT_API_KEY=... node scripts/robot_simulator.js https://<your-deployment>.vercel.app 1500
```

Regenerate `data/gridsense.json` after re-running the model (needs `pandas` and `pyarrow`):

```bash
py scripts/export_model_data.py path/to/model/outputs
```
