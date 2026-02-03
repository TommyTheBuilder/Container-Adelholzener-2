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
const ADMIN_KEY = process.env.ADMIN_KEY || "333"; // bei Render als ENV setzen!
const DATA_FILE = path.join(__dirname, "data.json");
// ====================

app.use(express.static("public"));

// Standard-Daten
const defaultState = () => {
  const obj = {};
  for (let i = 1; i <= 8; i++) obj[i] = { color: "red", plate: "" };
  return obj;
};

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultState();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    // Minimal-Validation
    for (let i = 1; i <= 8; i++) {
      if (!data[i]) data[i] = { color: "red", plate: "" };
      if (!["red", "green"].includes(data[i].color)) data[i].color = "red";
      if (typeof data[i].plate !== "string") data[i].plate = "";
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

let containerStatus = loadState();

io.on("connection", (socket) => {
  // init an jeden Client
  socket.emit("init", containerStatus);

  // admin auth status
  socket.data.isAdmin = false;

  socket.on("adminAuth", ({ key }) => {
    if (key && key === ADMIN_KEY) {
      socket.data.isAdmin = true;
      socket.emit("adminAuthResult", { ok: true });
    } else {
      socket.emit("adminAuthResult", { ok: false });
    }
  });

  socket.on("updateStatus", ({ id, color }) => {
    if (!socket.data.isAdmin) return;
    if (!containerStatus[id]) return;
    if (!["red", "green"].includes(color)) return;

    containerStatus[id].color = color;
    saveState(containerStatus);
    io.emit("statusChanged", { id, data: containerStatus[id] });
  });

  socket.on("updatePlate", ({ id, plate }) => {
    if (!socket.data.isAdmin) return;
    if (!containerStatus[id]) return;

    const safePlate = String(plate ?? "").trim().slice(0, 20);
    containerStatus[id].plate = safePlate;
    saveState(containerStatus);
    io.emit("statusChanged", { id, data: containerStatus[id] });
  });

  socket.on("resetAll", () => {
    if (!socket.data.isAdmin) return;
    containerStatus = defaultState();
    saveState(containerStatus);
    io.emit("init", containerStatus);
  });
});

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`ADMIN_KEY ist gesetzt? ${ADMIN_KEY !== "CHANGE_ME"}`);
});