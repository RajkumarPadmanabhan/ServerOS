"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");
const { createDb } = require("./db");
const { createHub } = require("./hub");
const { createAgent } = require("./agent");
const { mountRoutes } = require("./routes");
const { createBackupManager } = require("./backup");
const { writeIcons } = require("./icon");
const {
  VERSION,
  assertSameOrigin,
  isLoopback,
  lanIps,
  formatOwnerCode,
  makeOwnerCode,
  platformName,
  defaultDeviceName,
  readJson,
  writeJson,
  openBrowser
} = require("./util");

const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 16) {
  console.error("ServerOS needs Node.js 16 or newer. You have " + process.versions.node + ".");
  console.error("Download it from https://nodejs.org and run this again.");
  process.exit(1);
}

const baseDir = process.env.SERVEROS_DIR
  ? path.resolve(process.env.SERVEROS_DIR)
  : path.join(__dirname, "..");
const publicDir = path.join(__dirname, "..", "public");
const dataDir = path.join(baseDir, "data");
const storageDir = path.join(baseDir, "storage");
const tmpDir = path.join(baseDir, "tmp");
const configPath = path.join(dataDir, "config.json");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(storageDir, "home"), { recursive: true });
fs.mkdirSync(path.join(storageDir, "local"), { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });
writeIcons(publicDir);

const holder = { config: readJson(configPath) || {} };
const ownerCode = makeOwnerCode();
let currentPort = parseInt(process.env.SERVEROS_PORT || "8787", 10) || 8787;
let agent = null;

const db = createDb(path.join(dataDir, "db.json"));
const hub = createHub(db);
const dummyHash = bcrypt.hashSync("serveros-dummy-password", 10);
let backup = null;

function getConfig() {
  return holder.config || {};
}

function setConfig(next) {
  if (!next) {
    holder.config = {};
    try { fs.unlinkSync(configPath); } catch (err) {}
    return;
  }
  holder.config = next;
  writeJson(configPath, next);
}

function getMode() {
  if (holder.config.mode === "linked") return "linked";
  if (holder.config.mode === "home" || db.userCount() > 0) return "home";
  return "setup";
}

function startLinkedAgent() {
  stopLinkedAgent();
  const config = getConfig();
  if (config.mode !== "linked" || !config.homeUrl || !config.token) return;
  agent = createAgent({
    homeUrl: config.homeUrl,
    deviceId: config.deviceId || "",
    deviceName: config.deviceName || defaultDeviceName(),
    platform: platformName(),
    root: path.join(storageDir, "local"),
    tmpDir: tmpDir,
    getToken: function () {
      return getConfig().token || "";
    },
    onWelcome: function (info) {
      const fresh = Object.assign({}, getConfig());
      fresh.mode = "linked";
      fresh.deviceId = info.deviceId;
      if (info.name) fresh.deviceName = info.name;
      setConfig(fresh);
      if (backup) {
        backup.noteDeviceId(info.deviceId);
        backup.pullFromHome().catch(function () {});
      }
    },
    onRename: function (name) {
      const fresh = Object.assign({}, getConfig());
      fresh.deviceName = name;
      setConfig(fresh);
    },
    onRemoved: function () {
      stopLinkedAgent();
      setConfig(null);
    },
    onAuthFail: function () {}
  });
}

function stopLinkedAgent() {
  if (!agent) return;
  const current = agent;
  agent = null;
  current.stop();
}

function agentState() {
  if (agent) return agent.getState();
  const config = getConfig();
  return {
    online: false,
    lastError: config.mode === "linked" ? "Not connected yet." : "",
    deviceName: config.deviceName || defaultDeviceName(),
    deviceId: config.deviceId || "",
    homeUrl: config.homeUrl || ""
  };
}

const app = express();
app.disable("x-powered-by");
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.use(function (req, res, next) {
  if (getMode() === "linked" && !isLoopback(req)) {
    res.status(403).type("text").send("Open the main ServerOS address. This extra device can be managed from the computer it is running on.");
    return;
  }
  next();
});
app.use(express.json({ limit: "20mb" }));
app.use(function (req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  try {
    assertSameOrigin(req);
    next();
  } catch (err) {
    next(err);
  }
});

backup = createBackupManager({
  storageDir: storageDir,
  tmpDir: tmpDir,
  dataDir: dataDir,
  getConfig: getConfig,
  setConfig: setConfig
});

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: 1024 * 1024 * 1024, files: 100 }
});

mountRoutes(app, {
  db: db,
  hub: hub,
  upload: upload,
  storageDir: storageDir,
  tmpDir: tmpDir,
  ownerCode: ownerCode,
  getMode: getMode,
  getConfig: getConfig,
  setConfig: setConfig,
  getPort: function () { return currentPort; },
  startLinkedAgent: startLinkedAgent,
  stopLinkedAgent: stopLinkedAgent,
  agentState: agentState,
  dummyHash: dummyHash,
  backup: backup
});

app.use("/api", function (req, res) {
  res.status(404).json({ error: "That action was not found." });
});
app.use(express.static(publicDir, {
  index: "index.html",
  etag: true,
  maxAge: 0,
  setHeaders: function (res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  }
}));
app.use(function (req, res) {
  res.status(404).type("text").send("That page was not found.");
});
app.use(function (err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "That file is larger than 1 GB." });
    return;
  }
  if (err && err.code === "LIMIT_FILE_COUNT") {
    res.status(400).json({ error: "You can upload up to 100 files at a time." });
    return;
  }
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    res.status(400).json({ error: "That request was too large or not valid." });
    return;
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? "Something went wrong on this device." : (err.message || "Something went wrong.");
  res.status(status).json({ error: message });
});

function banner(port) {
  const ips = lanIps();
  console.log("");
  console.log("ServerOS is running");
  console.log("-------------------");
  console.log("On this device:  http://127.0.0.1:" + port);
  if (!ips.length) {
    console.log("No Wi-Fi address yet. Other devices can connect after this one joins a network.");
  } else {
    ips.forEach(function (ip) {
      console.log("On your Wi-Fi:   http://" + ip + ":" + port);
    });
  }
  console.log("");
  console.log("Owner code: " + formatOwnerCode(ownerCode));
  console.log("Use this code if you create the account from a phone or another computer.");
  console.log("");
  console.log("Leave this window open while you want live access.");
  console.log("Backups copied to another device can still be opened if this one is off.");
  console.log("");
}

function listenFrom(port, attempts) {
  currentPort = port;
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server: server, path: "/api/link", maxPayload: 4 * 1024 * 1024 });
  wss.on("connection", function (ws) {
    if (getMode() !== "home") {
      ws.close(4000, "not-home");
      return;
    }
    hub.handleConnection(ws);
  });
  server.on("error", function (err) {
    try { wss.close(); } catch (closeErr) {}
    try { server.close(); } catch (closeErr) {}
    if (err.code === "EADDRINUSE" && attempts > 0) {
      console.log("Port " + port + " is busy. Trying " + (port + 1) + ".");
      listenFrom(port + 1, attempts - 1);
      return;
    }
    console.error(err.message || err);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", function () {
    if (getMode() === "linked") startLinkedAgent();
    setInterval(function () {
      if (getMode() === "linked" && backup) backup.pullFromHome().catch(function () {});
    }, 15000).unref();
    banner(port);
    openBrowser("http://127.0.0.1:" + port + "/");
  });
}

process.on("SIGINT", function () {
  try { db.flush(); } catch (err) {}
  process.exit(0);
});
process.on("SIGTERM", function () {
  try { db.flush(); } catch (err) {}
  process.exit(0);
});
process.on("unhandledRejection", function (err) {
  console.error(err);
});

console.log("ServerOS " + VERSION);
listenFrom(currentPort, 20);
