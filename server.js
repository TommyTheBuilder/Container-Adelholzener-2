const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ====== CONFIG ======
const PORT = Number(process.env.PORT || 3004);
const HISTORY_MAX = Number(process.env.HISTORY_MAX || 5000);
const BASE_URL = process.env.BASE_URL || "https://container.paletten-ms.de";
const SHARED_AUTH_SECRET = String(process.env.SHARED_AUTH_SECRET || "13215489156189421598412").trim();
const ADMIN_ROLE = String(process.env.ADMIN_ROLE || "ContainerAnmeldung").trim();
const ADMIN_PERMISSION_KEY = String(process.env.ADMIN_PERMISSION_KEY || "integration.container_login").trim();
const ADMIN_AUTH_DATABASE_URL = String(
  process.env.ADMIN_AUTH_DATABASE_URL || "postgresql://palettenuser:DEIN_STARKES_PASSWORT@localhost:5432/palettenmanagement"
).trim();
const DEFAULT_ADMIN_AUTH_QUERY = `
  SELECT 1
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE LOWER(u.username) = LOWER($1)
    AND p.key = $2
  LIMIT 1
`;
const ADMIN_AUTH_QUERY = (() => {
  const raw = String(process.env.ADMIN_AUTH_QUERY || "").trim();
  if (!raw) return DEFAULT_ADMIN_AUTH_QUERY.trim();

  const looksLikeSql = /^select\b/i.test(raw);
  const hasParams = raw.includes("$1") && raw.includes("$2");
  if (looksLikeSql && hasParams) return raw;

  console.warn("Invalid ADMIN_AUTH_QUERY configured. Falling back to default query.");
  return DEFAULT_ADMIN_AUTH_QUERY.trim();
})();
const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || "session").trim();

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
    }
  : {
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "containeranmeldung",
      user: String(process.env.PGUSER || "containera"),
      password: String(process.env.PGPASSWORD || "containera"),
      ssl: dbSsl
    };
// ====================

const pool = new Pool(DB_CONFIG);
const authPool = ADMIN_AUTH_DATABASE_URL ? new Pool({ connectionString: ADMIN_AUTH_DATABASE_URL, ssl: dbSsl }) : null;

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

const STATUS_SLOT_CREATED = "slot_created";
const STATUS_REGISTERED = "registered";
const STATUS_TO_RAMP = "to_ramp";
const STATUS_WAITING_CUSTOMS = "waiting_customs";
const STATUS_CUSTOMS_RELEASED = "customs_released";

const LEGACY_STATUS_MAP = {
  red: STATUS_SLOT_CREATED,
  orange: STATUS_REGISTERED,
  green: STATUS_TO_RAMP
};

const STATUSES = [
  STATUS_SLOT_CREATED,
  STATUS_REGISTERED,
  STATUS_TO_RAMP,
  STATUS_WAITING_CUSTOMS,
  STATUS_CUSTOMS_RELEASED
];

function defaultContainer(id) {
  return {
    id,
    status: STATUS_SLOT_CREATED,
    plate: "",
    time: "",
    registeredAt: "",
    bookingNo: null
  };
}

function normalizeContainer(row) {
  return {
    status: STATUSES.includes(row.status)
      ? row.status
      : (LEGACY_STATUS_MAP[row.status] || STATUS_SLOT_CREATED),
    plate: typeof row.plate === "string" ? row.plate : "",
    time: typeof row.time === "string" ? row.time : "",
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : "",
    bookingNo: Number.isInteger(row.booking_no) ? row.booking_no : null
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'slot_created',
      plate TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '',
      registered_at TIMESTAMPTZ,
      booking_no BIGINT
    )
  `);

  await pool.query(`
    ALTER TABLE containers
    ADD COLUMN IF NOT EXISTS booking_no BIGINT
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


  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_counter (
      id INTEGER PRIMARY KEY,
      value BIGINT NOT NULL
    )
  `);

  await pool.query(
    `INSERT INTO booking_counter (id, value)
     VALUES (1, 0)
     ON CONFLICT (id) DO NOTHING`
  );

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
    "SELECT id, status, plate, time, registered_at, booking_no FROM containers ORDER BY id"
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
         registered_at = $5,
         booking_no = $6
     WHERE id = $1`,
    [id, data.status, data.plate, data.time, data.registeredAt || null, data.bookingNo || null]
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
             registered_at = $5,
             booking_no = $6
         WHERE id = $1`,
        [i, data.status, data.plate, data.time, data.registeredAt || null, data.bookingNo || null]
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

async function nextBookingNo() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE booking_counter
       SET value = value + 1
       WHERE id = 1
       RETURNING value`
    );
    await client.query("COMMIT");
    return Number(updated.rows[0]?.value || 1);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getBookingTimeline(bookingNo) {
  const n = Number(bookingNo);
  if (!Number.isInteger(n) || n <= 0) return [];

  const result = await pool.query(
    `SELECT at, type, container_id AS "containerId", plate, details
     FROM history
     WHERE details->>'bookingNo' = $1
     ORDER BY id ASC`,
    [String(n)]
  );
  return result.rows;
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


function decodeBase64Url(input) {
  if (!input) return "";
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseRoles(rawRoles) {
  if (Array.isArray(rawRoles)) return rawRoles.map((v) => String(v).trim()).filter(Boolean);
  if (typeof rawRoles === "string") return rawRoles.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return cookies;

  for (const part of cookieHeader.split(";")) {
    const segment = String(part || "").trim();
    if (!segment) continue;
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    const name = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function validateSharedSessionToken(token) {
  if (!SHARED_AUTH_SECRET || !token || typeof token !== "string") {
    return { ok: false };
  }

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false };

  const [payloadPart, signaturePart] = parts;
  const expectedSig = crypto
    .createHmac("sha256", SHARED_AUTH_SECRET)
    .update(payloadPart)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expectedSig);
  const receivedBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== receivedBuffer.length) return { ok: false };
  if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return { ok: false };

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadPart));
  } catch (_error) {
    return { ok: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload?.exp || 0);
  if (!Number.isInteger(exp) || exp <= now) return { ok: false };

  const roles = parseRoles(payload?.roles);
  const user = String(payload?.user || payload?.username || "").trim();
  if (!user) return { ok: false };

  return {
    ok: true,
    user,
    roles
  };
}

async function hasAdminPermission(user) {
  if (!authPool || !user || !ADMIN_PERMISSION_KEY) return false;

  try {
    const result = await authPool.query(ADMIN_AUTH_QUERY, [user, ADMIN_PERMISSION_KEY]);
    return result.rowCount > 0;
  } catch (error) {
    console.error("admin permission query failed", { message: error.message });
    return false;
  }
}

function resolveSessionToken(cookieHeader) {
  const cookies = parseCookieHeader(typeof cookieHeader === "string" ? cookieHeader : "");

  const fromConfiguredCookie = String(cookies[SESSION_COOKIE_NAME] || "").trim();
  if (fromConfiguredCookie) return fromConfiguredCookie;

  const fromLegacySessionCookie = String(cookies.session || "").trim();
  if (fromLegacySessionCookie) return fromLegacySessionCookie;

  return String(cookies.token || "").trim();
}

async function resolveAdminAccess(cookieHeader = "") {
  const session = resolveSessionToken(cookieHeader);
  const validated = validateSharedSessionToken(session);
  if (validated.ok && await hasAdminPermission(validated.user)) {
    return { ok: true, source: "shared_session", user: validated.user, roles: validated.roles };
  }

  return { ok: false, source: "none", user: "", roles: [] };
}

let containers = {};

function emitOne(id) {
  io.emit("statusChanged", { id, data: containers[id] });
}

app.get("/admin-history.csv", async (req, res) => {
  try {
    const auth = await resolveAdminAccess(req.headers.cookie || "");
    if (!auth.ok) return res.status(403).send("Forbidden");

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
  socket.data.adminUser = "";
  socket.data.adminRoles = [];
  socket.emit("init", containers);

  socket.on("adminAuth", async () => {
    const auth = await resolveAdminAccess(socket.handshake.headers.cookie || "");
    if (auth.ok) {
      socket.data.isAdmin = true;
      socket.data.adminUser = auth.user || "";
      socket.data.adminRoles = auth.roles || [];
      socket.emit("adminAuthResult", { ok: true, user: socket.data.adminUser, roles: socket.data.adminRoles });
      return;
    }

    socket.data.isAdmin = false;
    socket.data.adminUser = "";
    socket.data.adminRoles = [];
    socket.emit("adminAuthResult", { ok: false });
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

  socket.on("adminGetBookingTimeline", async ({ bookingNo }) => {
    if (!socket.data.isAdmin) return;
    try {
      const entries = await getBookingTimeline(bookingNo);
      socket.emit("adminBookingTimeline", { bookingNo, entries });
    } catch (error) {
      socket.emit("adminBookingTimeline", { bookingNo, entries: [], error: error.message });
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

    const isFree = containers[cid].status === STATUS_SLOT_CREATED && !containers[cid].plate.trim();
    if (!isFree) {
      socket.emit("driverRegisterResult", {
        ok: false,
        message: "Dieser Container ist bereits belegt. Bitte anderen Container wählen oder beim Personal melden."
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const bookingNo = await nextBookingNo();
    containers[cid].plate = safePlate;
    containers[cid].status = STATUS_REGISTERED;
    containers[cid].registeredAt = nowIso;
    containers[cid].bookingNo = bookingNo;

    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "driver_register",
      at: nowIso,
      containerId: cid,
      plate: safePlate,
      details: { bookingNo, timeSlot: containers[cid].time || "", startedAt: nowIso }
    });

    socket.emit("driverRegisterResult", { ok: true, message: "Erfolgreich angemeldet. Bitte warten." });
  });

  socket.on("adminSetStatus", async ({ id, status }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;
    if (!STATUSES.includes(status)) return;

    const before = containers[cid].status;
    containers[cid].status = status;
    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "admin_set_status",
      at: new Date().toISOString(),
      containerId: cid,
      plate: containers[cid].plate || "",
      details: { bookingNo: containers[cid].bookingNo || null, from: before, to: status }
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
      details: { bookingNo: containers[cid].bookingNo || null, from: before, to: safeTime }
    });
  });

  socket.on("adminResetContainer", async ({ id }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const before = { ...containers[cid] };
    const finishedAt = new Date().toISOString();
    containers[cid] = defaultContainer(cid);

    await saveContainer(cid, containers[cid]);
    emitOne(cid);

    await logEvent({
      type: "admin_reset_container",
      at: new Date().toISOString(),
      containerId: cid,
      plate: before.plate || "",
      details: { bookingNo: before.bookingNo || null, completedAt: finishedAt, before }
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
