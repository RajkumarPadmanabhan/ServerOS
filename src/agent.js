"use strict";

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const storage = require("./storage");

function createAgent(options) {
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let backoff = 2000;
  let state = {
    online: false,
    lastError: "",
    deviceName: options.deviceName,
    deviceId: options.deviceId || "",
    homeUrl: options.homeUrl
  };
  const uploads = new Map();
  const downloads = new Map();
  const acks = new Map();

  function setState(patch) {
    state = Object.assign({}, state, patch);
  }

  function wsUrl() {
    return String(state.homeUrl || "").replace(/^http/, "ws") + "/api/link";
  }

  function cleanupUpload(id) {
    const item = uploads.get(id);
    if (!item) return;
    uploads.delete(id);
    try { item.stream.destroy(); } catch (err) {}
    fs.unlink(item.tmp, function () {});
  }

  function handleOp(msg) {
    const root = options.root;
    if (msg.op === "list") return storage.list(root, msg.path || "");
    if (msg.op === "mkdir") return storage.mkdir(root, msg.path || "", msg.name);
    if (msg.op === "delete") return storage.remove(root, msg.path || "");
    if (msg.op === "rename") return storage.rename(root, msg.path || "", msg.name);
    if (msg.op === "usage") return storage.usage(root);
    throw new Error("That action is not available.");
  }

  function sendUsage(ws) {
    try {
      const usage = storage.usage(options.root);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "status", usedBytes: usage.bytes, fileCount: usage.files }));
      }
    } catch (err) {}
  }

  function startDownload(ws, msg) {
    let filePath;
    try {
      filePath = storage.resolveExistingFile(options.root, msg.path);
    } catch (err) {
      ws.send(JSON.stringify({ type: "err", id: msg.id, error: err.message || "That file was not found." }));
      return;
    }
    const st = fs.statSync(filePath);
    const name = path.basename(filePath);
    ws.send(JSON.stringify({
      type: "download-meta",
      id: msg.id,
      name: name,
      size: st.size,
      mime: storage.mimeFor(name, false),
      inlineOk: storage.canInline(name)
    }));
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    downloads.set(msg.id, stream);
    stream.on("data", function (chunk) {
      stream.pause();
      acks.set(msg.id, function () {
        if (!stream.destroyed) stream.resume();
      });
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "download-chunk", id: msg.id, data: chunk.toString("base64") }));
      }
    });
    stream.on("end", function () {
      downloads.delete(msg.id);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "download-end", id: msg.id }));
    });
    stream.on("error", function () {
      downloads.delete(msg.id);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "err", id: msg.id, error: "Could not read that file." }));
    });
  }

  function startUpload(ws, msg) {
    fs.mkdirSync(options.tmpDir, { recursive: true });
    const tmp = path.join(options.tmpDir, "up-" + msg.id);
    const stream = fs.createWriteStream(tmp);
    uploads.set(msg.id, { stream: stream, tmp: tmp, dir: msg.dir || "", name: msg.name || "file" });
    stream.on("error", function () {
      const current = uploads.get(msg.id);
      if (current) current.settled = true;
      cleanupUpload(msg.id);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "upload-result", id: msg.id, ok: false, error: "Could not save that file on this device." }));
      }
    });
    stream.on("open", function () {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "upload-ready", id: msg.id }));
    });
  }

  function writeChunk(ws, msg) {
    const item = uploads.get(msg.id);
    if (!item) return;
    const buf = Buffer.from(msg.data || "", "base64");
    const ack = function () {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "upload-ack", id: msg.id }));
    };
    if (!item.stream.write(buf)) item.stream.once("drain", ack);
    else ack();
  }

  function finishUpload(ws, msg) {
    const item = uploads.get(msg.id);
    if (!item || item.settled) return;
    item.settled = true;
    uploads.delete(msg.id);
    item.stream.end(function () {
      try {
        const entry = storage.saveUpload(options.root, item.dir, item.name, item.tmp);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "upload-result", id: msg.id, ok: true, entry: entry }));
      } catch (err) {
        fs.unlink(item.tmp, function () {});
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "upload-result", id: msg.id, ok: false, error: err.message || "Could not save that file." }));
        }
      }
    });
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl(), { maxPayload: 4 * 1024 * 1024 });
    } catch (err) {
      setState({ online: false, lastError: "Could not reach your main ServerOS." });
      schedule();
      return;
    }
    socket = ws;
    const usageTimer = setInterval(function () { sendUsage(ws); }, 20000);

    ws.on("open", function () {
      ws.send(JSON.stringify({
        type: "hello",
        token: options.getToken(),
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        platform: options.platform
      }));
    });

    ws.on("message", function (buf) {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (err) { return; }
      if (msg.type === "welcome") {
        backoff = 2000;
        setState({
          online: true,
          lastError: "",
          deviceId: msg.deviceId,
          deviceName: msg.name || state.deviceName
        });
        if (options.onWelcome) options.onWelcome({ deviceId: msg.deviceId, name: msg.name });
        sendUsage(ws);
        return;
      }
      if (msg.type === "rename" && msg.name) {
        setState({ deviceName: msg.name });
        if (options.onRename) options.onRename(msg.name);
        return;
      }
      if (msg.type === "removed") {
        stopped = true;
        setState({ online: false, lastError: "This device was removed from your ServerOS." });
        if (options.onRemoved) options.onRemoved();
        try { ws.close(); } catch (err) {}
        return;
      }
      if (msg.type === "ack" && acks.has(msg.id)) {
        const fn = acks.get(msg.id);
        acks.delete(msg.id);
        fn();
        return;
      }
      if (msg.type === "cancel") {
        const stream = downloads.get(msg.id);
        if (stream) stream.destroy();
        downloads.delete(msg.id);
        cleanupUpload(msg.id);
        return;
      }
      if (msg.type === "op") {
        try {
          const data = handleOp(msg);
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: data }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: err.message || "Could not do that." }));
        }
        return;
      }
      if (msg.type === "download") startDownload(ws, msg);
      else if (msg.type === "upload-start") startUpload(ws, msg);
      else if (msg.type === "upload-chunk") writeChunk(ws, msg);
      else if (msg.type === "upload-end") finishUpload(ws, msg);
    });

    ws.on("close", function (code) {
      clearInterval(usageTimer);
      socket = null;
      for (const id of uploads.keys()) cleanupUpload(id);
      for (const stream of downloads.values()) {
        try { stream.destroy(); } catch (err) {}
      }
      downloads.clear();
      if (stopped) return;
      if (code === 4001) {
        setState({ online: false, lastError: "The password changed or the login expired. Join again." });
        if (options.onAuthFail) options.onAuthFail();
        return;
      }
      setState({ online: false, lastError: "Your main ServerOS is not reachable. It may be off." });
      schedule();
    });

    ws.on("error", function () {
      setState({ online: false, lastError: "Your main ServerOS is not reachable. It may be off." });
    });
  }

  function schedule() {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  connect();

  return {
    stop: function () {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket) {
        try { socket.close(); } catch (err) {}
      }
    },
    getState: function () { return state; }
  };
}

module.exports = { createAgent };
