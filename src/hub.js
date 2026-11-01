"use strict";

const fs = require("fs");
const { HttpError, newId, contentDisposition } = require("./util");
const storage = require("./storage");

function createHub(db) {
  const sockets = new Map();
  const jobs = new Map();
  const stats = new Map();

  function isOnline(deviceId) {
    const ws = sockets.get(deviceId);
    return !!(ws && ws.readyState === 1);
  }

  function getStats(deviceId) {
    return stats.get(deviceId) || null;
  }

  function failJobs(deviceId, message) {
    for (const job of jobs.values()) {
      if (job.deviceId === deviceId) job.fail(message);
    }
  }

  function closeDevice(deviceId, removed) {
    const ws = sockets.get(deviceId);
    if (ws) {
      try {
        if (removed && ws.readyState === 1) ws.send(JSON.stringify({ type: "removed" }));
        ws.close(removed ? 4000 : 1000, removed ? "removed" : "bye");
      } catch (err) {}
      sockets.delete(deviceId);
    }
    failJobs(deviceId, "That device disconnected.");
  }

  function notifyRename(deviceId, name) {
    const ws = sockets.get(deviceId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "rename", name: name }));
  }

  function sessionStillValid(ws) {
    return !!(ws.sessionToken && db.getSession(ws.sessionToken));
  }

  function handleConnection(ws) {
    let deviceId = null;
    ws.isAlive = true;
    ws.on("pong", function () {
      ws.isAlive = true;
      if (!sessionStillValid(ws)) {
        ws.close(4001, "login");
        return;
      }
      if (deviceId) db.touchDevice(deviceId);
    });

    ws.on("message", function (buf) {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (err) {
        return;
      }
      if (!deviceId) {
        if (!msg || msg.type !== "hello") {
          ws.close(4001, "hello-first");
          return;
        }
        const session = db.getSession(msg.token);
        if (!session) {
          ws.close(4001, "login");
          return;
        }
        ws.sessionToken = msg.token;
        let existing = msg.deviceId ? db.getDevice(msg.deviceId) : null;
        if (existing && (existing.userId !== session.userId || existing.role === "home")) existing = null;
        let device = existing;
        if (device) {
          device.platform = String(msg.platform || device.platform || "Computer").slice(0, 40);
          db.touchDevice(device.id);
        } else {
          const requested = msg.deviceId && /^[a-f0-9]{16}$/.test(msg.deviceId) ? msg.deviceId : undefined;
          device = db.createDevice({
            id: requested,
            userId: session.userId,
            name: String(msg.deviceName || "Another device").replace(/[<>:"/\\|?*\r\n]/g, "").trim().slice(0, 40) || "Another device",
            platform: String(msg.platform || "Computer").slice(0, 40),
            role: "linked"
          });
        }
        deviceId = device.id;
        const previous = sockets.get(deviceId);
        if (previous && previous !== ws) {
          try { previous.close(); } catch (err) {}
        }
        sockets.set(deviceId, ws);
        ws.send(JSON.stringify({ type: "welcome", deviceId: device.id, name: device.name }));
        console.log("Device connected: " + device.name + " (" + device.platform + ")");
        return;
      }

      if (!sessionStillValid(ws)) {
        ws.close(4001, "login");
        return;
      }

      if (msg.type === "status") {
        stats.set(deviceId, {
          usedBytes: Number(msg.usedBytes) || 0,
          fileCount: Number(msg.fileCount) || 0
        });
        db.touchDevice(deviceId);
        return;
      }

      const job = msg.id ? jobs.get(msg.id) : null;
      if (!job || job.deviceId !== deviceId) return;
      if (msg.type === "res") job.onRes(msg);
      else if (msg.type === "upload-ready") job.onReady();
      else if (msg.type === "upload-ack") job.onAck();
      else if (msg.type === "upload-result") job.onResult(msg);
      else if (msg.type === "download-meta") job.onMeta(msg);
      else if (msg.type === "download-chunk") job.onChunk(msg);
      else if (msg.type === "download-end") job.onEnd();
      else if (msg.type === "err") job.fail(msg.error || "The other device could not do that.");
    });

    ws.on("close", function () {
      if (deviceId && sockets.get(deviceId) === ws) {
        sockets.delete(deviceId);
        console.log("Device disconnected.");
      }
      if (deviceId) failJobs(deviceId, "That device disconnected.");
    });
    ws.on("error", function () {});
  }

  function requireSocket(deviceId) {
    const ws = sockets.get(deviceId);
    if (!ws || ws.readyState !== 1) {
      throw new HttpError(409, "That device is offline. Open ServerOS on it and leave it running.");
    }
    return ws;
  }

  function arm(job, ms) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(function () {
      job.fail("That device took too long to respond.");
    }, ms);
  }

  function ask(deviceId, payload, timeoutMs) {
    const ws = requireSocket(deviceId);
    const id = newId();
    return new Promise(function (resolve, reject) {
      const job = {
        deviceId: deviceId,
        done: false,
        fail: function (message) {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          reject(new HttpError(409, message));
        },
        onRes: function (msg) {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          if (!msg.ok) reject(new HttpError(400, msg.error || "The other device could not do that."));
          else resolve(msg.data);
        },
        onReady: function () {},
        onAck: function () {},
        onResult: function () {},
        onMeta: function () {},
        onChunk: function () {},
        onEnd: function () {}
      };
      jobs.set(id, job);
      arm(job, timeoutMs || 30000);
      ws.send(JSON.stringify(Object.assign({ type: "op", id: id }, payload)));
    });
  }

  function upload(deviceId, dir, name, tempPath) {
    const ws = requireSocket(deviceId);
    const id = newId();
    const size = fs.statSync(tempPath).size;
    return new Promise(function (resolve, reject) {
      const fd = fs.openSync(tempPath, "r");
      let offset = 0;
      let closed = false;
      const buf = Buffer.alloc(256 * 1024);
      function closeFd() {
        if (closed) return;
        closed = true;
        try { fs.closeSync(fd); } catch (err) {}
      }
      const job = {
        deviceId: deviceId,
        done: false,
        fail: function (message) {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          closeFd();
          try { ws.send(JSON.stringify({ type: "cancel", id: id })); } catch (err) {}
          reject(new HttpError(409, message));
        },
        onRes: function () {},
        onReady: function () { sendNext(); },
        onAck: function () { sendNext(); },
        onResult: function (msg) {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          closeFd();
          if (!msg.ok) reject(new HttpError(400, msg.error || "Upload failed on that device."));
          else resolve(msg.entry);
        },
        onMeta: function () {},
        onChunk: function () {},
        onEnd: function () {}
      };
      function sendNext() {
        if (job.done) return;
        arm(job, 120000);
        if (offset >= size) {
          ws.send(JSON.stringify({ type: "upload-end", id: id }));
          return;
        }
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) {
          ws.send(JSON.stringify({ type: "upload-end", id: id }));
          return;
        }
        offset += n;
        ws.send(JSON.stringify({
          type: "upload-chunk",
          id: id,
          data: buf.slice(0, n).toString("base64")
        }));
      }
      jobs.set(id, job);
      arm(job, 30000);
      ws.send(JSON.stringify({
        type: "upload-start",
        id: id,
        dir: dir || "",
        name: name,
        size: size
      }));
    });
  }

  function download(deviceId, relPath, res, inlineWanted) {
    const ws = requireSocket(deviceId);
    const id = newId();
    return new Promise(function (resolve, reject) {
      let started = false;
      const job = {
        deviceId: deviceId,
        done: false,
        fail: function (message) {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          try { ws.send(JSON.stringify({ type: "cancel", id: id })); } catch (err) {}
          if (!started) reject(new HttpError(409, message));
          else {
            try { res.end(); } catch (err) {}
            resolve();
          }
        },
        onRes: function () {},
        onReady: function () {},
        onAck: function () {},
        onResult: function () {},
        onMeta: function (msg) {
          if (job.done) return;
          started = true;
          arm(job, 120000);
          const name = msg.name || path.basename(relPath) || "file";
          const allow = !!inlineWanted && !!msg.inlineOk;
          res.setHeader("Content-Type", storage.mimeFor(name, allow));
          res.setHeader("Content-Length", String(msg.size || 0));
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "private, no-store");
          res.setHeader("Content-Disposition", contentDisposition(name, allow));
        },
        onChunk: function (msg) {
          if (job.done) return;
          arm(job, 120000);
          const chunk = Buffer.from(msg.data || "", "base64");
          const ok = res.write(chunk);
          const ack = function () {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ack", id: id }));
          };
          if (!ok) res.once("drain", ack);
          else ack();
        },
        onEnd: function () {
          if (job.done) return;
          job.done = true;
          if (job.timer) clearTimeout(job.timer);
          jobs.delete(id);
          res.end();
          resolve();
        }
      };
      jobs.set(id, job);
      arm(job, 30000);
      res.on("close", function () {
        if (!res.writableFinished) job.fail("Cancelled");
      });
      ws.send(JSON.stringify({ type: "download", id: id, path: relPath }));
    });
  }

  const interval = setInterval(function () {
    for (const [id, ws] of sockets) {
      if (!ws.isAlive) {
        sockets.delete(id);
        try { ws.terminate(); } catch (err) {}
        failJobs(id, "That device disconnected.");
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (err) {}
    }
  }, 15000);
  if (interval.unref) interval.unref();

  return {
    handleConnection: handleConnection,
    isOnline: isOnline,
    getStats: getStats,
    closeDevice: closeDevice,
    notifyRename: notifyRename,
    ask: ask,
    upload: upload,
    download: download
  };
}

module.exports = { createHub };
