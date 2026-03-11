const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ====== CONFIG ======
const PORT = Number(process.env.PORT || 3004);
const ADMIN_KEY = process.env.ADMIN_KEY || "333";
const HISTORY_MAX = Number(process.env.HISTORY_MAX || 5000);
const BASE_URL = process.env.BASE_URL || "https://container.paletten-ms.de";

const rawDatabaseUrl = String(process.env.DATABASE_URL || "").trim();
const hasDatabaseUrl = rawDatabaseUrl.length > 0;
const hasPgEnvOverride = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].some((key) =>
  Object.prototype.hasOwnProperty.call(process.env, key)
);

const dbSsl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;

const DB_CONFIG = hasDatabaseUrl && !hasPgEnvOverride
  ? {
      connectionString: rawDatabaseUrl,
      ssl: dbSsl
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const DB_CONFIG = hasDatabaseUrl
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
    }
  : {
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "containeranmeldung",
      user: String(process.env.PGUSER || "containera"),
      password: String(process.env.PGPASSWORD || "containera"),
      ssl: dbSsl
      user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD || "",
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
    };
// ====================

const pool = new Pool(DB_CONFIG);

app.use(express.static("public"));

app.get("/", (req, res) => res.redirect("/viewer.html"));
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "container-status-board", baseUrl: BASE_URL });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const STATUSES = ["red", "orange", "green"]; // rot=warten, orange=angemeldet, grün=rampe

function defaultContainer(id) {
  return {
    id,
    status: "red",
    plate: "",
    time: "",
    registeredAt: ""
  };
}

function normalizeContainer(row) {
  return {
    status: STATUSES.includes(row.status) ? row.status : "red",
    plate: typeof row.plate === "string" ? row.plate : "",
    time: typeof row.time === "string" ? row.time : "",
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : ""
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'red',
      plate TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '',
      registered_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      container_id INTEGER NOT NULL,
      plate TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  for (let i = 1; i <= 8; i++) {
    const c = defaultContainer(i);
    await pool.query(
      `INSERT INTO containers (id, status, plate, time, registered_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.status, c.plate, c.time]
    );
  }
}

async function loadState() {
  const result = await pool.query(
    "SELECT id, status, plate, time, registered_at FROM containers ORDER BY id"
  );

  const state = {};
  for (let i = 1; i <= 8; i++) {
    state[i] = defaultContainer(i);
  }

  for (const row of result.rows) {
    state[row.id] = normalizeContainer(row);
  }

  return state;
}

async function saveContainer(id, data) {
  await pool.query(
    `UPDATE containers
     SET status = $2,
         plate = $3,
         time = $4,
         registered_at = $5
     WHERE id = $1`,
    [id, data.status, data.plate, data.time, data.registeredAt || null]
  );
}

async function saveAllContainers(state) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 1; i <= 8; i++) {
      const data = state[i] || defaultContainer(i);
      await client.query(
        `UPDATE containers
         SET status = $2,
             plate = $3,
             time = $4,
             registered_at = $5
         WHERE id = $1`,
        [i, data.status, data.plate, data.time, data.registeredAt || null]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function logEvent(evt) {
  await pool.query(
    `INSERT INTO history (at, type, container_id, plate, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [evt.at, evt.type, evt.containerId, evt.plate || "", JSON.stringify(evt.details || {})]
  );

  await pool.query(
    `DELETE FROM history
     WHERE id IN (
       SELECT id FROM history
       ORDER BY id DESC
       OFFSET $1
     )`,
    [HISTORY_MAX]
  );
}

async function getHistory(limit) {
  const n = Math.max(1, Math.min(Number(limit || 200), 2000));
  const result = await pool.query(
    `SELECT at, type, container_id AS "containerId", plate, details
     FROM history
     ORDER BY id DESC
     LIMIT $1`,
    [n]
  );
  return result.rows;
}

async function clearHistory() {
  await pool.query("TRUNCATE TABLE history RESTART IDENTITY");
}

function historyToCSV(entries) {
  const header = ["at", "type", "containerId", "plate", "details"];
  const lines = [header.join(";")];

  for (const e of entries) {
    const row = [
      e.at ?? "",
      e.type ?? "",
      e.containerId ?? "",
      (e.plate ?? "").replaceAll(";", " "),
      JSON.stringify(e.details ?? {}).replaceAll(";", " ")
    ];
    lines.push(row.join(";"));
  }
  return lines.join("\n");
}

let containers = {};

function emitOne(id) {
  io.emit("statusChanged", { id, data: containers[id] });
}

app.get("/admin-history.csv", async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (key !== ADMIN_KEY) return res.status(403).send("Forbidden");

    const entries = await getHistory(1000);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=history.csv");
    return res.send(historyToCSV(entries.reverse()));
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

io.on("connection", (socket) => {
  socket.data.isAdmin = false;
  socket.emit("init", containers);

  socket.on("adminAuth", ({ key }) => {
    if (key && key === ADMIN_KEY) {
      socket.data.isAdmin = true;
      socket.emit("adminAuthResult", { ok: true });
    } else {
      socket.emit("adminAuthResult", { ok: false });
    }
  });

  socket.on("adminGetHistory", async ({ limit }) => {
    if (!socket.data.isAdmin) return;
    try {
      const entries = await getHistory(limit);
      socket.emit("adminHistory", { entries });
    } catch (error) {
      socket.emit("adminHistory", { entries: [], error: error.message });
    }
  });

  socket.on("adminClearHistory", async () => {
    if (!socket.data.isAdmin) return;
    await clearHistory();
    socket.emit("adminHistory", { entries: [] });
  });

  socket.on("driverRegister", async ({ id, plate }) => {
    const cid = Number(id);
    if (!containers[cid]) {
      socket.emit("driverRegisterResult", { ok: false, message: "Ungültiger Container." });
      return;
    }

    const safePlate = String(plate ?? "").trim().toUpperCase().slice(0, 20);
    if (!safePlate) {
      socket.emit("driverRegisterResult", { ok: false, message: "Bitte Kennzeichen eingeben." });
      return;
    }

    const isFree = containers[cid].status === "red" && !containers[cid].plate.trim();
    if (!isFree) {
      socket.emit("driverRegisterResult", {
        ok: false,
        message: "Dieser Container ist bereits belegt. Bitte anderen Container wählen oder beim Personal melden."
      });
      return;
    }

    const nowIso = new Date().toISOString();
    containers[cid].plate = safePlate;
    containers[cid].status = "orange";
    containers[cid].registeredAt = nowIso;

    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "driver_register",
      at: nowIso,
      containerId: cid,
      plate: safePlate,
      details: { timeSlot: containers[cid].time || "" }
    });

    socket.emit("driverRegisterResult", { ok: true, message: "Erfolgreich angemeldet. Bitte warten." });
  });

  socket.on("adminSetStatus", async ({ id, status }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;
    if (status !== "red" && status !== "green") return;

    const before = containers[cid].status;
    containers[cid].status = status;
    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "admin_set_status",
      at: new Date().toISOString(),
      containerId: cid,
      plate: containers[cid].plate || "",
      details: { from: before, to: status }
    });
  });

  socket.on("adminSetTime", async ({ id, time }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const safeTime = String(time ?? "").trim().slice(0, 5);
    if (safeTime && !/^\d{2}:\d{2}$/.test(safeTime)) return;

    const before = containers[cid].time;
    containers[cid].time = safeTime;
    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "admin_set_time",
      at: new Date().toISOString(),
      containerId: cid,
      plate: containers[cid].plate || "",
      details: { from: before, to: safeTime }
    });
  });

  socket.on("adminResetContainer", async ({ id }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const before = { ...containers[cid] };
    containers[cid] = defaultContainer(cid);

    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "admin_reset_container",
      at: new Date().toISOString(),
      containerId: cid,
      plate: before.plate || "",
      details: { before }
    });
  });

  socket.on("resetAll", async () => {
    if (!socket.data.isAdmin) return;

    containers = {};
    for (let i = 1; i <= 8; i++) containers[i] = defaultContainer(i);

    await saveAllContainers(containers);
    io.emit("init", containers);

    await logEvent({
      type: "admin_reset_all",
      at: new Date().toISOString(),
      containerId: 0,
      plate: "",
      details: {}
    });
  });
});

async function bootstrap() {
  await initDb();
  containers = await loadState();

  server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Basis-URL: ${BASE_URL}`);
    if (hasDatabaseUrl) {
      console.log("PostgreSQL verbunden via DATABASE_URL");
    } else {
      console.log(`PostgreSQL verbunden: ${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
    }
  });
}

bootstrap().catch((error) => {
  console.error("Fehler beim Start: PostgreSQL-Verbindung fehlgeschlagen.");
  console.error("Prüfe DATABASE_URL oder PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.");
  console.error(error);
  process.exit(1);
});
