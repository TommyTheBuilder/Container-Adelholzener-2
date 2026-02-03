const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "333";
const DATA_FILE = path.join(__dirname, "data.json");
const HISTORY_FILE = path.join(__dirname, "history.json");
const HISTORY_MAX = 5000; // max Einträge, dann werden die ältesten entfernt
// ====================

app.use(express.static("public"));

// Komfort: Root öffnet Viewer
app.get("/", (req, res) => res.redirect("/viewer.html"));

const STATUSES = ["red", "orange", "green"]; // rot=warten, orange=angemeldet, grün=rampe

function defaultState() {
  const obj = {};
  for (let i = 1; i <= 8; i++) {
    obj[i] = {
      status: "red",
      plate: "",
      time: "",          // "HH:MM"
      registeredAt: ""   // ISO string
    };
  }
  return obj;
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultState();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);

    for (let i = 1; i <= 8; i++) {
      if (!data[i]) data[i] = defaultState()[i];
      if (!STATUSES.includes(data[i].status)) data[i].status = "red";
      if (typeof data[i].plate !== "string") data[i].plate = "";
      if (typeof data[i].time !== "string") data[i].time = "";
      if (typeof data[i].registeredAt !== "string") data[i].registeredAt = "";
    }
    return data;
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Konnte data.json nicht speichern:", e.message);
  }
}

// ===== Historie =====
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

let history = loadHistory();

function saveHistory() {
  try {
    // begrenzen
    if (history.length > HISTORY_MAX) {
      history = history.slice(history.length - HISTORY_MAX);
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
  } catch (e) {
    console.error("Konnte history.json nicht speichern:", e.message);
  }
}

function logEvent(evt) {
  // evt: {type, at, containerId, plate?, details?}
  history.push(evt);
  saveHistory();
}

// CSV export helper (für Admin)
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

// Optional: Admin kann CSV über URL holen (nur mit key)
app.get("/admin-history.csv", (req, res) => {
  const key = String(req.query.key || "");
  if (key !== ADMIN_KEY) return res.status(403).send("Forbidden");
  const last = history.slice(-1000); // letzte 1000 Einträge
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=history.csv");
  res.send(historyToCSV(last));
});
// ====================

let containers = loadState();

function emitOne(id) {
  io.emit("statusChanged", { id, data: containers[id] });
}

io.on("connection", (socket) => {
  socket.data.isAdmin = false;

  socket.emit("init", containers);

  // ===== Admin Auth =====
  socket.on("adminAuth", ({ key }) => {
    if (key && key === ADMIN_KEY) {
      socket.data.isAdmin = true;
      socket.emit("adminAuthResult", { ok: true });
    } else {
      socket.emit("adminAuthResult", { ok: false });
    }
  });

  // ===== Admin: Historie holen =====
  socket.on("adminGetHistory", ({ limit }) => {
    if (!socket.data.isAdmin) return;
    const n = Math.max(1, Math.min(Number(limit || 200), 2000));
    socket.emit("adminHistory", { entries: history.slice(-n).reverse() }); // neueste zuerst
  });

  // (Optional) Admin: Historie löschen
  socket.on("adminClearHistory", () => {
    if (!socket.data.isAdmin) return;
    history = [];
    saveHistory();
    socket.emit("adminHistory", { entries: [] });
  });

  // ===== Fahrer: Registrierung =====
  // Regel: Fahrer darf NICHT überschreiben, wenn Slot nicht frei ist.
  // "frei" = status == red UND plate leer
  socket.on("driverRegister", ({ id, plate }) => {
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
    containers[cid].status = "orange"; // Angemeldet
    containers[cid].registeredAt = nowIso;

    saveState(containers);
    emitOne(cid);

    // ✅ HISTORIE: Fahrer Anmeldung
    logEvent({
      type: "driver_register",
      at: nowIso,
      containerId: cid,
      plate: safePlate,
      details: { timeSlot: containers[cid].time || "" }
    });

    socket.emit("driverRegisterResult", { ok: true, message: "Erfolgreich angemeldet. Bitte warten." });
  });

  // ===== Admin: Status setzen (nur rot/grün) =====
  socket.on("adminSetStatus", ({ id, status }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    if (status !== "red" && status !== "green") return;

    const before = containers[cid].status;
    containers[cid].status = status;
    saveState(containers);
    emitOne(cid);

    logEvent({
      type: "admin_set_status",
      at: new Date().toISOString(),
      containerId: cid,
      plate: containers[cid].plate || "",
      details: { from: before, to: status }
    });
  });

  // ===== Admin: Termin setzen =====
  socket.on("adminSetTime", ({ id, time }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const safeTime = String(time ?? "").trim().slice(0, 5);
    if (safeTime && !/^\d{2}:\d{2}$/.test(safeTime)) return;

    const before = containers[cid].time;
    containers[cid].time = safeTime;
    saveState(containers);
    emitOne(cid);

    logEvent({
      type: "admin_set_time",
      at: new Date().toISOString(),
      containerId: cid,
      plate: containers[cid].plate || "",
      details: { from: before, to: safeTime }
    });
  });

  // ===== Admin: Container zurücksetzen =====
  socket.on("adminResetContainer", ({ id }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const before = { ...containers[cid] };

    containers[cid] = defaultState()[cid];
    saveState(containers);
    emitOne(cid);

    logEvent({
      type: "admin_reset_container",
      at: new Date().toISOString(),
      containerId: cid,
      plate: before.plate || "",
      details: { before }
    });
  });

  // ===== Admin: Alles zurücksetzen =====
  socket.on("resetAll", () => {
    if (!socket.data.isAdmin) return;

    containers = defaultState();
    saveState(containers);
    io.emit("init", containers);

    logEvent({
      type: "admin_reset_all",
      at: new Date().toISOString(),
      containerId: 0,
      plate: "",
      details: {}
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`ADMIN_KEY ist gesetzt? ${ADMIN_KEY !== "CHANGE_ME"}`);
});

