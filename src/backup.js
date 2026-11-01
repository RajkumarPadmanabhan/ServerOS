"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { postJson } = require("./util");

const SKIP_DIRS = {
  node_modules: true,
  ".git": true,
  ".cache": true,
  Cache: true,
  "Code Cache": true,
  GPUCache: true,
  Temp: true,
  tmp: true,
  INetCache: true,
  "Temporary Internet Files": true
};

function isTermux() {
  return String(process.env.PREFIX || "").indexOf("com.termux") !== -1;
}

function isInside(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (rel.indexOf("..") !== 0 && !path.isAbsolute(rel));
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function safeDeviceId(id) {
  const value = String(id || "");
  if (!/^[a-f0-9]{16}$/.test(value) && value !== "this-device") return "";
  return value;
}

function blobName(file) {
  return file.id + (file.method === "gzip" ? ".gz" : ".bin");
}

function safeBlobName(name) {
  const value = String(name || "");
  if (!/^[a-f0-9]{32}\.(gz|bin)$/.test(value)) return "";
  return value;
}

function createBackupManager(options) {
  const backupRoot = path.join(options.storageDir, "backups");
  const appRoot = path.resolve(path.join(__dirname, ".."));
  const state = {
    running: false,
    phase: "idle",
    done: 0,
    total: 0,
    current: "",
    originalBytes: 0,
    storedBytes: 0,
    skipped: 0,
    error: "",
    lastRun: 0,
    copiedToOthers: false
  };

  fs.mkdirSync(backupRoot, { recursive: true });

  function roots() {
    if (process.env.SERVEROS_BACKUP_ROOT) {
      return [path.resolve(process.env.SERVEROS_BACKUP_ROOT)];
    }
    if (isTermux()) {
      return [process.env.EXTERNAL_STORAGE || "/storage/emulated/0"];
    }
    return [os.homedir()];
  }

  function scopeText() {
    if (process.env.SERVEROS_BACKUP_ROOT) return "The folder chosen for this backup.";
    if (isTermux()) return "Files on this phone: photos, downloads, documents, and the rest of shared storage.";
    if (process.platform === "win32") {
      return "Your Windows user folder (Desktop, Documents, Downloads, Pictures, and the rest), except temporary caches and ServerOS itself.";
    }
    if (process.platform === "darwin") {
      return "Your Mac user folder, except temporary caches and ServerOS itself.";
    }
    return "Your user folder, except temporary caches and ServerOS itself.";
  }

  function androidReady() {
    if (!isTermux()) return true;
    const shared = process.env.EXTERNAL_STORAGE || "/storage/emulated/0";
    try {
      fs.readdirSync(shared);
      return true;
    } catch (err) {
      return false;
    }
  }

  function forbidden(full) {
    const resolved = path.resolve(full);
    if (isInside(backupRoot, resolved)) return true;
    if (isInside(options.storageDir, resolved)) return true;
    if (isInside(options.tmpDir, resolved)) return true;
    if (isInside(options.dataDir, resolved)) return true;
    const explicit = process.env.SERVEROS_BACKUP_ROOT ? path.resolve(process.env.SERVEROS_BACKUP_ROOT) : "";
    if (isInside(appRoot, resolved) && !(explicit && isInside(explicit, resolved))) return true;
    const norm = resolved.replace(/\//g, "\\").toLowerCase();
    if (norm.indexOf("\\appdata\\local\\") !== -1) return true;
    if (norm.indexOf("\\appdata\\locallow\\") !== -1) return true;
    return false;
  }

  function skipDir(name) {
    return !!SKIP_DIRS[name] || name === "$Recycle.Bin" || name === "System Volume Information";
  }

  async function collect(absRoot, dir, out) {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (let i = 0; i < dirents.length; i++) {
      const ent = dirents[i];
      if (!ent || ent.name === "." || ent.name === "..") continue;
      const full = path.join(dir, ent.name);
      if (typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink()) continue;
      if (forbidden(full)) continue;
      if (ent.isDirectory()) {
        if (skipDir(ent.name)) continue;
        await collect(absRoot, full, out);
      } else if (ent.isFile()) {
        if (ent.name === "Thumbs.db" || ent.name === "desktop.ini") continue;
        const rel = path.relative(absRoot, full).split(path.sep).join("/");
        out.push({ full: full, rel: path.basename(absRoot) + "/" + rel });
      }
      if (out.length % 40 === 0) await delay(0);
    }
  }

  function gzipTo(from, to) {
    return new Promise(function (resolve, reject) {
      const input = fs.createReadStream(from);
      const output = fs.createWriteStream(to);
      const gzip = zlib.createGzip({ level: 9 });
      function fail(err) {
        input.destroy();
        gzip.destroy();
        output.destroy();
        reject(err);
      }
      input.on("error", fail);
      gzip.on("error", fail);
      output.on("error", fail);
      output.on("finish", resolve);
      input.pipe(gzip).pipe(output);
    });
  }

  function copyStream(from, to) {
    return new Promise(function (resolve, reject) {
      const input = fs.createReadStream(from);
      const output = fs.createWriteStream(to);
      input.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      input.pipe(output);
    });
  }

  function freeBytes() {
    try {
      if (!fs.statfsSync) return null;
      const stat = fs.statfsSync(options.storageDir);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (err) {
      return null;
    }
  }

  function deviceFolder(deviceId) {
    const id = safeDeviceId(deviceId);
    if (!id) throw new Error("That backup was not found.");
    return path.join(backupRoot, id);
  }

  function manifestPath(deviceId) {
    return path.join(deviceFolder(deviceId), "manifest.json");
  }

  function readManifest(deviceId) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath(deviceId), "utf8"));
    } catch (err) {
      return null;
    }
  }

  function writeManifest(deviceId, manifest) {
    const dir = deviceFolder(deviceId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "manifest.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    fs.renameSync(tmp, path.join(dir, "manifest.json"));
  }

  function blobPath(deviceId, file) {
    const name = safeBlobName(blobName(file));
    if (!name) throw new Error("That backup file is not valid.");
    const full = path.join(deviceFolder(deviceId), "blobs", name);
    const root = path.resolve(deviceFolder(deviceId));
    if (!isInside(root, full)) throw new Error("That backup file is not valid.");
    return full;
  }

  function sourceId() {
    const cfg = options.getConfig() || {};
    return safeDeviceId(cfg.deviceId) || "this-device";
  }

  function deviceName() {
    const cfg = options.getConfig() || {};
    return cfg.deviceName || os.hostname() || "This device";
  }

  async function storeOne(item, blobDir) {
    let st;
    try {
      st = fs.statSync(item.full);
    } catch (err) {
      return null;
    }
    if (!st.isFile()) return null;
    const id = crypto.createHash("sha256")
      .update(item.rel + "\0" + st.size + "\0" + Math.round(st.mtimeMs))
      .digest("hex")
      .slice(0, 32);
    const gz = path.join(blobDir, id + ".gz");
    const bin = path.join(blobDir, id + ".bin");
    if (fs.existsSync(gz) || fs.existsSync(bin)) {
      const method = fs.existsSync(gz) ? "gzip" : "store";
      const stored = fs.statSync(method === "gzip" ? gz : bin).size;
      state.originalBytes += st.size;
      state.storedBytes += stored;
      return { id: id, path: item.rel, size: st.size, stored: stored, method: method, mtime: st.mtimeMs };
    }
    const partial = path.join(blobDir, id + ".part");
    try {
      await gzipTo(item.full, partial);
      const compressed = fs.statSync(partial).size;
      let method = "gzip";
      let stored = compressed;
      if (st.size > 0 && compressed >= st.size) {
        fs.unlinkSync(partial);
        await copyStream(item.full, bin);
        method = "store";
        stored = st.size;
      } else {
        fs.renameSync(partial, gz);
      }
      state.originalBytes += st.size;
      state.storedBytes += stored;
      return { id: id, path: item.rel, size: st.size, stored: stored, method: method, mtime: st.mtimeMs };
    } catch (err) {
      try { fs.unlinkSync(partial); } catch (ignore) {}
      return null;
    }
  }

  function postFile(urlString, token, headers, filePath) {
    return new Promise(function (resolve, reject) {
      const u = new URL(urlString);
      const stat = fs.statSync(filePath);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: Object.assign({
          Authorization: "Bearer " + token,
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size
        }, headers)
      }, function (res) {
        const chunks = [];
        res.on("data", function (chunk) { chunks.push(chunk); });
        res.on("end", function () {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (err) { json = {}; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.error || "Could not copy the backup to your other device."));
        });
      });
      req.on("error", function () { reject(new Error("Your other device is not reachable right now.")); });
      fs.createReadStream(filePath).pipe(req);
    });
  }

  function getJson(urlString, token) {
    return new Promise(function (resolve, reject) {
      const u = new URL(urlString);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" }
      }, function (res) {
        const chunks = [];
        res.on("data", function (chunk) { chunks.push(chunk); });
        res.on("end", function () {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (err) { json = {}; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.error || "Could not reach the main ServerOS."));
        });
      });
      req.on("error", function () { reject(new Error("The main ServerOS is not reachable.")); });
      req.end();
    });
  }

  function downloadTo(urlString, token, dest) {
    return new Promise(function (resolve, reject) {
      const u = new URL(urlString);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      const output = fs.createWriteStream(tmp);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Authorization: "Bearer " + token }
      }, function (res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error("Could not copy a backup file."));
          return;
        }
        res.pipe(output);
        output.on("finish", function () {
          fs.renameSync(tmp, dest);
          resolve();
        });
      });
      req.on("error", function (err) {
        try { fs.unlinkSync(tmp); } catch (ignore) {}
        reject(err);
      });
      req.end();
    });
  }

  async function pushToHome(manifest) {
    const cfg = options.getConfig() || {};
    if (cfg.mode !== "linked" || !cfg.homeUrl || !cfg.token) return false;
    await postJson(cfg.homeUrl + "/api/backup/replica/manifest", { manifest: manifest }, {
      Authorization: "Bearer " + cfg.token
    });
    for (let i = 0; i < manifest.files.length; i++) {
      const file = manifest.files[i];
      state.current = "Copying " + file.path;
      await postFile(cfg.homeUrl + "/api/backup/replica/blob", cfg.token, {
        "X-Backup-Device": manifest.deviceId,
        "X-Backup-Name": blobName(file)
      }, blobPath(manifest.deviceId, file));
    }
    return true;
  }

  async function pullFromHome() {
    const cfg = options.getConfig() || {};
    if (cfg.mode !== "linked" || !cfg.homeUrl || !cfg.token || state.running) return;
    let library;
    try {
      library = await getJson(cfg.homeUrl + "/api/backup/library?full=1", cfg.token);
    } catch (err) {
      return;
    }
    const backups = library.backups || [];
    for (let i = 0; i < backups.length; i++) {
      const item = backups[i];
      if (!safeDeviceId(item.deviceId)) continue;
      const local = readManifest(item.deviceId);
      const have = {};
      if (local && local.files) {
        for (let f = 0; f < local.files.length; f++) have[local.files[f].id] = true;
      }
      const files = item.files || [];
      for (let f = 0; f < files.length; f++) {
        const file = files[f];
        const dest = path.join(deviceFolder(item.deviceId), "blobs", blobName(file));
        if (have[file.id] && fs.existsSync(dest)) continue;
        const url = cfg.homeUrl + "/api/backup/blob?deviceId=" + encodeURIComponent(item.deviceId) + "&id=" + encodeURIComponent(file.id);
        try {
          await downloadTo(url, cfg.token, dest);
        } catch (err) {
          return;
        }
      }
      writeManifest(item.deviceId, {
        deviceId: item.deviceId,
        deviceName: item.deviceName,
        updatedAt: item.updatedAt,
        originalBytes: item.originalBytes,
        storedBytes: item.storedBytes,
        files: files
      });
    }
  }

  async function run() {
    if (state.running) return publicStatus();
    const cfg = options.getConfig() || {};
    if (cfg.backupConsent !== true) {
      state.error = "Allow file access before the backup can start.";
      state.phase = "needs-permission";
      return publicStatus();
    }
    state.running = true;
    state.phase = "scanning";
    state.error = "";
    state.done = 0;
    state.total = 0;
    state.skipped = 0;
    state.originalBytes = 0;
    state.storedBytes = 0;
    state.copiedToOthers = false;
    state.current = "";
    try {
      if (!androidReady()) {
        state.phase = "needs-permission";
        state.error = "Android has not allowed storage yet. Tap Allow phone storage, then start the backup again.";
        state.running = false;
        return publicStatus();
      }
      const found = [];
      const startRoots = roots();
      for (let i = 0; i < startRoots.length; i++) {
        if (!fs.existsSync(startRoots[i])) continue;
        await collect(startRoots[i], startRoots[i], found);
      }
      state.total = found.length;
      let bytes = 0;
      for (let i = 0; i < found.length; i++) {
        try { bytes += fs.statSync(found[i].full).size; } catch (err) {}
      }
      const free = freeBytes();
      if (free != null && bytes > free * 0.85) {
        throw new Error("There is not enough free space on this device for a full backup. Free some space, then try again.");
      }
      state.phase = "compressing";
      const deviceId = sourceId();
      const blobDir = path.join(deviceFolder(deviceId), "blobs");
      fs.mkdirSync(blobDir, { recursive: true });
      const saved = [];
      for (let i = 0; i < found.length; i++) {
        state.done = i;
        state.current = found[i].rel;
        const item = await storeOne(found[i], blobDir);
        if (item) saved.push(item);
        else state.skipped += 1;
        if (i % 3 === 0) await delay(0);
      }
      state.done = found.length;
      const manifest = {
        deviceId: deviceId,
        deviceName: deviceName(),
        updatedAt: Date.now(),
        originalBytes: state.originalBytes,
        storedBytes: state.storedBytes,
        files: saved
      };
      writeManifest(deviceId, manifest);
      state.phase = "copying";
      state.current = "Copying the backup to your other devices";
      try {
        state.copiedToOthers = await pushToHome(manifest);
      } catch (err) {
        state.error = err.message || "The local backup is saved, but it could not be copied to another device yet.";
      }
      state.lastRun = Date.now();
      state.phase = state.error ? "done" : "done";
      state.current = "";
    } catch (err) {
      state.phase = "error";
      state.error = err.message || "The backup did not finish.";
    } finally {
      state.running = false;
    }
    return publicStatus();
  }

  function publicStatus() {
    const cfg = options.getConfig() || {};
    const saved = state.originalBytes - state.storedBytes;
    return {
      consent: cfg.backupConsent === true,
      asked: cfg.backupConsent === true || cfg.backupConsent === false,
      running: state.running,
      phase: state.phase,
      done: state.done,
      total: state.total,
      current: state.current,
      originalBytes: state.originalBytes,
      storedBytes: state.storedBytes,
      savedBytes: saved > 0 ? saved : 0,
      skipped: state.skipped,
      error: state.error,
      lastRun: state.lastRun,
      copiedToOthers: state.copiedToOthers,
      android: isTermux(),
      androidReady: androidReady(),
      scope: scopeText(),
      role: cfg.mode === "linked" ? "linked" : "home"
    };
  }

  function setConsent(allow) {
    const next = Object.assign({}, options.getConfig() || {}, { backupConsent: !!allow });
    options.setConfig(next);
    if (!allow) {
      state.phase = "idle";
      state.error = "";
    }
    return publicStatus();
  }

  function askAndroid() {
    if (!isTermux()) {
      return { ok: true, message: "This device does not need a separate Android permission." };
    }
    try {
      const child = spawn("termux-setup-storage", { detached: true, stdio: "ignore" });
      child.unref();
    } catch (err) {
      return { ok: false, message: "In Termux, run termux-setup-storage and tap Allow." };
    }
    return { ok: true, message: "If Android asks to allow storage, tap Allow. Then start the backup again." };
  }

  function library() {
    let names = [];
    try { names = fs.readdirSync(backupRoot); } catch (err) { return []; }
    const backups = [];
    for (let i = 0; i < names.length; i++) {
      if (!safeDeviceId(names[i])) continue;
      const manifest = readManifest(names[i]);
      if (!manifest || !manifest.files) continue;
      backups.push({
        deviceId: manifest.deviceId,
        deviceName: manifest.deviceName || "Device",
        updatedAt: manifest.updatedAt || 0,
        originalBytes: manifest.originalBytes || 0,
        storedBytes: manifest.storedBytes || 0,
        fileCount: manifest.files.length,
        files: manifest.files
      });
    }
    return backups;
  }

  function browse(deviceId, rel) {
    const manifest = readManifest(deviceId);
    if (!manifest) return null;
    const prefix = rel ? String(rel).replace(/^\/+|\/+$/g, "") + "/" : "";
    const folders = {};
    const files = [];
    const list = manifest.files || [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (prefix && file.path.indexOf(prefix) !== 0) continue;
      const rest = prefix ? file.path.slice(prefix.length) : file.path;
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(file);
      else folders[rest.slice(0, slash)] = true;
    }
    return {
      deviceName: manifest.deviceName || "Device",
      path: rel || "",
      folders: Object.keys(folders).sort(),
      files: files
    };
  }

  function fileMeta(deviceId, id) {
    const manifest = readManifest(deviceId);
    if (!manifest) return null;
    const files = manifest.files || [];
    for (let i = 0; i < files.length; i++) {
      if (files[i].id === id) return files[i];
    }
    return null;
  }

  function sendFile(res, deviceId, id) {
    const meta = fileMeta(deviceId, id);
    if (!meta) {
      res.status(404).json({ error: "That backup file was not found." });
      return;
    }
    const full = blobPath(deviceId, meta);
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: "That backup file is not on this device." });
      return;
    }
    const name = meta.path.split("/").pop() || "file";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "attachment; filename=\"" + name.replace(/["\\]/g, "_") + "\"");
    if (meta.method === "gzip") {
      res.setHeader("Content-Type", "application/octet-stream");
      fs.createReadStream(full).pipe(zlib.createGunzip()).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(meta.size || fs.statSync(full).size));
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(full).pipe(res);
  }

  function saveReplicaManifest(manifest) {
    if (!manifest || !safeDeviceId(manifest.deviceId) || !Array.isArray(manifest.files)) {
      throw new Error("That backup list is not valid.");
    }
    const files = [];
    for (let i = 0; i < manifest.files.length; i++) {
      const file = manifest.files[i];
      if (!file || !/^[a-f0-9]{32}$/.test(file.id)) continue;
      if (file.method !== "gzip" && file.method !== "store") continue;
      files.push({
        id: file.id,
        path: String(file.path || "file").replace(/\\/g, "/").slice(0, 300),
        size: Number(file.size) || 0,
        stored: Number(file.stored) || 0,
        method: file.method,
        mtime: Number(file.mtime) || 0
      });
    }
    writeManifest(manifest.deviceId, {
      deviceId: manifest.deviceId,
      deviceName: String(manifest.deviceName || "Device").slice(0, 40),
      updatedAt: Date.now(),
      originalBytes: Number(manifest.originalBytes) || 0,
      storedBytes: Number(manifest.storedBytes) || 0,
      files: files
    });
  }

  function saveReplicaBlob(deviceId, name, req) {
    return new Promise(function (resolve, reject) {
      const id = safeDeviceId(deviceId);
      const blob = safeBlobName(name);
      if (!id || !blob) {
        reject(new Error("That backup file is not valid."));
        return;
      }
      const dest = path.join(deviceFolder(id), "blobs", blob);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      const output = fs.createWriteStream(tmp);
      req.pipe(output);
      output.on("finish", function () {
        fs.renameSync(tmp, dest);
        resolve();
      });
      output.on("error", reject);
      req.on("error", reject);
    });
  }

  function rawBlob(deviceId, id) {
    const meta = fileMeta(deviceId, id);
    if (!meta) return null;
    const full = blobPath(deviceId, meta);
    if (!fs.existsSync(full)) return null;
    return { meta: meta, full: full };
  }

  function noteDeviceId(id) {
    if (!safeDeviceId(id) || id === "this-device") return;
    const from = path.join(backupRoot, "this-device");
    const to = path.join(backupRoot, id);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try { fs.renameSync(from, to); } catch (err) {}
    }
  }

  return {
    publicStatus: publicStatus,
    setConsent: setConsent,
    askAndroid: askAndroid,
    start: function () { run(); return publicStatus(); },
    library: library,
    browse: browse,
    sendFile: sendFile,
    saveReplicaManifest: saveReplicaManifest,
    saveReplicaBlob: saveReplicaBlob,
    rawBlob: rawBlob,
    pullFromHome: pullFromHome,
    noteDeviceId: noteDeviceId
  };
}

module.exports = { createBackupManager };
