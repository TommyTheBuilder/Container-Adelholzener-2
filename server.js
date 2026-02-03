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
const ADMIN_KEY = process.env.ADMIN_KEY || "CHANGE_ME";
const DATA_FILE = path.join(__dirname, "data.json");
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

    // Minimal-Validation + Auffüllen
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

    containers[cid].plate = safePlate;
    containers[cid].status = "orange"; // Angemeldet
    containers[cid].registeredAt = new Date().toISOString();

    saveState(containers);
    emitOne(cid);

    socket.emit("driverRegisterResult", { ok: true, message: "Erfolgreich angemeldet. Bitte warten." });
  });

  // ===== Admin: Status setzen (nur rot/grün) =====
  socket.on("adminSetStatus", ({ id, status }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    // Admin darf nur rot oder grün setzen (orange nur durch Fahrer)
    if (status !== "red" && status !== "green") return;

    containers[cid].status = status;
    saveState(containers);
    emitOne(cid);
  });

  // ===== Admin: Termin setzen =====
  socket.on("adminSetTime", ({ id, time }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    const safeTime = String(time ?? "").trim().slice(0, 5); // "HH:MM"
    // sehr leichte Prüfung
    if (safeTime && !/^\d{2}:\d{2}$/.test(safeTime)) return;

    containers[cid].time = safeTime;
    saveState(containers);
    emitOne(cid);
  });

  // ===== Admin: Container zurücksetzen =====
  socket.on("adminResetContainer", ({ id }) => {
    if (!socket.data.isAdmin) return;

    const cid = Number(id);
    if (!containers[cid]) return;

    containers[cid] = defaultState()[cid];
    saveState(containers);
    emitOne(cid);
  });

  // ===== Admin: Alles zurücksetzen =====
  socket.on("resetAll", () => {
    if (!socket.data.isAdmin) return;
    containers = defaultState();
    saveState(containers);
    io.emit("init", containers);
  });
});

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`ADMIN_KEY ist gesetzt? ${ADMIN_KEY !== "CHANGE_ME"}`);
});
