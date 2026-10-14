const { neon } = require('@neondatabase/serverless');

let sql;
let ready;

function getDb() {
  if (!sql) {
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

// Creates every table the app needs. Runs once per warm serverless instance.
function initDb() {
  if (!ready) {
    const sql = getDb();
    ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;
      // One row per (scan point, access point) RSSI reading sent by the robot
      await sql`
        CREATE TABLE IF NOT EXISTS scans (
          id BIGSERIAL PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          device_id VARCHAR(64) NOT NULL,
          floor SMALLINT NOT NULL,
          e REAL NOT NULL,
          n REAL NOT NULL,
          mac VARCHAR(32) NOT NULL,
          ssid VARCHAR(64),
          rssi REAL NOT NULL,
          band VARCHAR(8),
          channel SMALLINT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS scans_session_id_idx ON scans (session_id, id)`;
      // Latest heartbeat per robot
      await sql`
        CREATE TABLE IF NOT EXISTS robot_status (
          device_id VARCHAR(64) PRIMARY KEY,
          session_id VARCHAR(64),
          floor SMALLINT,
          e REAL,
          n REAL,
          heading REAL,
          speed REAL,
          battery REAL,
          state VARCHAR(32),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

module.exports = { getDb, initDb };
