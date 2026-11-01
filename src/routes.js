"use strict";

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const storage = require("./storage");
const {
  HttpError,
  VERSION,
  isLoopback,
  platformName,
  defaultDeviceName,
  cleanDeviceName,
  formatOwnerCode,
  codesMatch,
  readCookie,
  sessionCookie,
  clearCookie,
  bearer,
  escapeHtml,
  makeRecoveryKey,
  hashRecovery,
  recoveryMatches,
  validEmail,
  validUsername,
  normalizeHome,
  postJson,
  bestOrigin,
  lanIps
} = require("./util");

function mountRoutes(app, ctx) {
  const db = ctx.db;
  const hub = ctx.hub;
  const buckets = new Map();
  let usageCache = { at: 0, bytes: 0, files: 0, userId: "" };

  function wrap(fn) {
    return function (req, res, next) {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  function locked(key) {
    const row = buckets.get(key);
    if (!row) return false;
    if (row.reset < Date.now()) {
      buckets.delete(key);
      return false;
    }
    return row.count >= row.limit;
  }

  function fail(key, limit, windowMs) {
    const now = Date.now();
    let row = buckets.get(key);
    if (!row || row.reset < now) row = { count: 0, reset: now + windowMs, limit: limit };
    row.count += 1;
    row.limit = limit;
    buckets.set(key, row);
  }

  function clearFail(key) {
    buckets.delete(key);
  }

  function homeRoot(userId) {
    const dir = path.join(ctx.storageDir, "home", userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function invalidateUsage(userId) {
    if (usageCache.userId === userId) usageCache.at = 0;
  }

  function homeUsage(userId) {
    const now = Date.now();
    if (usageCache.userId === userId && now - usageCache.at < 15000) return usageCache;
    const usage = storage.usage(homeRoot(userId));
    usageCache = { at: now, userId: userId, bytes: usage.bytes, files: usage.files };
    return usageCache;
  }

  function currentUser(req) {
    const token = readCookie(req, "sid") || bearer(req);
    const session = db.getSession(token);
    if (!session) return null;
    const user = db.findUserById(session.userId);
    if (!user) return null;
    return { user: user, token: token };
  }

  function requireUser(req, res, next) {
    if (ctx.getMode() !== "home") {
      res.status(400).json({ error: "Open the main ServerOS address to do this." });
      return;
    }
    const found = currentUser(req);
    if (!found) {
      res.status(401).json({ error: "Please log in again." });
      return;
    }
    req.user = found.user;
    req.sessionToken = found.token;
    next();
  }

  function requireLoopback(req, res, next) {
    if (!isLoopback(req)) {
      res.status(403).json({ error: "Do this on the device where this ServerOS window is open." });
      return;
    }
    next();
  }

  function assertOwner(req) {
    if (isLoopback(req)) return;
    const key = "owner:" + (req.socket.remoteAddress || "");
    if (locked(key)) {
      throw new HttpError(429, "Too many tries. Wait 10 minutes, then use the owner code from the ServerOS window.");
    }
    const body = req.body || {};
    if (!codesMatch(body.ownerCode, ctx.ownerCode)) {
      fail(key, 8, 10 * 60 * 1000);
      throw new HttpError(403, "That owner code is not right. Read it on the device where ServerOS is open.");
    }
  }

  function checkPassword(password) {
    const value = String(password || "");
    if (value.length < 8) throw new HttpError(400, "Use a password of at least 8 characters.");
    if (value.length > 200) throw new HttpError(400, "That password is too long.");
    return value;
  }

  function visibleDevice(user, deviceId) {
    const owner = db.firstUser();
    if (!deviceId) {
      const home = db.homeDevice(user.id) || (owner && db.homeDevice(owner.id));
      if (!home) throw new HttpError(404, "This ServerOS has no main device yet.");
      return home;
    }
    const device = db.getDevice(deviceId);
    if (!device) throw new HttpError(404, "That device is not on your account.");
    if (device.userId === user.id) return device;
    if (owner && device.userId === owner.id) return device;
    if (owner && user.id === owner.id) return device;
    throw new HttpError(404, "That device is not on your account.");
  }

  function ownedDevice(user, deviceId) {
    const device = visibleDevice(user, deviceId);
    if (device.userId !== user.id) {
      throw new HttpError(403, "You can open those files. Your own files are kept separately.");
    }
    return device;
  }

  async function actOnDevice(user, deviceId, localFn, remoteFn, write) {
    const device = write ? ownedDevice(user, deviceId) : visibleDevice(user, deviceId);
    if (device.role === "home") return localFn(device, homeRoot(device.userId));
    if (!hub.isOnline(device.id)) {
      throw new HttpError(409, device.name + " is offline. Turn it on and leave ServerOS open there.");
    }
    return remoteFn(device);
  }

  function presentDevice(device, viewerId) {
    const online = device.role === "home" ? true : hub.isOnline(device.id);
    let usedBytes = 0;
    let fileCount = 0;
    if (device.role === "home") {
      const usage = homeUsage(device.userId);
      usedBytes = usage.bytes;
      fileCount = usage.files;
    } else if (online) {
      const stats = hub.getStats(device.id);
      if (stats) {
        usedBytes = stats.usedBytes;
        fileCount = stats.fileCount;
      }
    }
    const owner = db.firstUser();
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      role: device.role,
      online: online,
      lastSeen: device.lastSeen,
      usedBytes: usedBytes,
      fileCount: fileCount,
      shared: !!(viewerId && device.userId !== viewerId),
      mine: !viewerId || device.userId === viewerId,
      owner: !!(owner && device.userId === owner.id)
    };
  }

  function shareUrl(token) {
    return bestOrigin(ctx.getPort()) + "/s/" + token;
  }

  function page(title, message) {
    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>" +
      escapeHtml(title) + "</title></head><body style=\"font-family:Segoe UI,sans-serif;background:#efeae2;color:#1e1a16;padding:32px\"><main style=\"max-width:460px;margin:40px auto;background:#fffdf8;padding:24px;border-radius:16px\"><h1 style=\"font-size:22px\">" +
      escapeHtml(title) + "</h1><p>" + escapeHtml(message) + "</p></main></body></html>";
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === "") return [];
    return [value];
  }

  function cleanupTemps(files) {
    (files || []).forEach(function (file) {
      fs.unlink(file.path, function () {});
    });
  }

  app.get("/api/bootstrap", function (req, res) {
    const mode = ctx.getMode();
    const found = mode === "home" ? currentUser(req) : null;
    const payload = {
      version: VERSION,
      mode: mode,
      onThisDevice: isLoopback(req),
      accountExists: db.userCount() > 0,
      suggestedName: defaultDeviceName(),
      user: found ? db.publicUser(found.user) : null,
      needsOwnerCode: mode !== "linked" && !isLoopback(req),
      ownerCode: isLoopback(req) ? formatOwnerCode(ctx.ownerCode) : null,
      backup: ctx.backup.publicStatus()
    };
    if (mode === "linked") {
      const config = ctx.getConfig();
      const node = ctx.agentState();
      payload.node = {
        online: node.online,
        lastError: node.lastError,
        deviceName: node.deviceName || config.deviceName || defaultDeviceName(),
        homeUrl: config.homeUrl || node.homeUrl || "",
        username: config.user && config.user.username || ""
      };
    }
    res.json(payload);
  });

  app.post("/api/register", wrap(async function (req, res) {
    if (ctx.getMode() === "linked") {
      throw new HttpError(400, "Create the account on the main device, then join from here.");
    }
    const firstAccount = db.userCount() === 0;
    assertOwner(req);
    const body = req.body || {};
    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = checkPassword(body.password);
    if (!validUsername(username)) {
      throw new HttpError(400, "Username should be 3 to 24 letters, numbers, or underscores.");
    }
    if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address.");
    if (db.findUserByLogin(username) || db.findUserByLogin(email)) {
      throw new HttpError(400, "That username or email is already used. Choose another, or log in.");
    }
    if (password.toLowerCase() === username.toLowerCase()) {
      throw new HttpError(400, "Use a password that is not your username.");
    }
    if (body.password !== body.confirmPassword) throw new HttpError(400, "Those passwords do not match.");
    const recoveryKey = makeRecoveryKey();
    const user = db.createUser({
      username: username,
      email: email,
      passwordHash: await bcrypt.hash(password, 10),
      recoveryHash: hashRecovery(recoveryKey)
    });
    const device = db.createDevice({
      userId: user.id,
      name: cleanDeviceName(body.deviceName),
      platform: platformName(),
      role: "home"
    });
    if (firstAccount) {
      ctx.setConfig({ mode: "home", deviceId: device.id, deviceName: device.name });
    }
    const session = db.createSession(user.id, "browser");
    res.setHeader("Set-Cookie", sessionCookie(session.token, 30 * 86400));
    res.json({ user: db.publicUser(user), recoveryKey: recoveryKey, device: presentDevice(device, user.id) });
  }));

  app.post("/api/login", wrap(async function (req, res) {
    if (ctx.getMode() !== "home") {
      throw new HttpError(400, "Log in from the main ServerOS address.");
    }
    const ip = req.socket.remoteAddress || "";
    if (locked("login:" + ip)) throw new HttpError(429, "Too many tries. Wait 10 minutes.");
    const body = req.body || {};
    const login = String(body.login || body.email || body.username || "").trim();
    const password = String(body.password || "");
    if (!login || !password) throw new HttpError(400, "Enter your email or username, and your password.");
    const user = db.findUserByLogin(login);
    const hash = user ? user.passwordHash : ctx.dummyHash;
    const matches = await bcrypt.compare(password, hash);
    if (!user || !matches) {
      fail("login:" + ip, 8, 10 * 60 * 1000);
      throw new HttpError(401, "That email, username, or password is not right.");
    }
    clearFail("login:" + ip);
    const link = body.link === true;
    const session = db.createSession(user.id, link ? "link" : "browser");
    res.setHeader("Set-Cookie", sessionCookie(session.token, (link ? 180 : 30) * 86400));
    const payload = { user: db.publicUser(user) };
    if (link) payload.token = session.token;
    res.json(payload);
  }));

  app.post("/api/logout", function (req, res) {
    const found = currentUser(req);
    if (found) db.deleteSession(found.token);
    res.setHeader("Set-Cookie", clearCookie());
    res.json({ ok: true });
  });

  app.post("/api/recover", wrap(async function (req, res) {
    if (ctx.getMode() !== "home") throw new HttpError(400, "Reset the password on the main ServerOS.");
    const ip = req.socket.remoteAddress || "";
    if (locked("recover:" + ip)) throw new HttpError(429, "Too many tries. Wait 10 minutes.");
    const body = req.body || {};
    const user = db.findUserByLogin(body.login || body.email || "");
    const keyOk = user ? recoveryMatches(body.recoveryKey, user.recoveryHash) : false;
    if (!user || !keyOk) {
      fail("recover:" + ip, 8, 10 * 60 * 1000);
      throw new HttpError(400, "That recovery key does not match this account.");
    }
    const password = checkPassword(body.password);
    if (body.password !== body.confirmPassword) throw new HttpError(400, "Those passwords do not match.");
    db.setPassword(user.id, await bcrypt.hash(password, 10));
    db.deleteUserSessions(user.id, null);
    clearFail("recover:" + ip);
    res.json({ ok: true });
  }));

  app.post("/api/password/local-reset", requireLoopback, wrap(async function (req, res) {
    const account = db.firstUser();
    if (!account) throw new HttpError(400, "Create an account first.");
    const body = req.body || {};
    const password = checkPassword(body.password);
    if (body.password !== body.confirmPassword) throw new HttpError(400, "Those passwords do not match.");
    db.setPassword(account.id, await bcrypt.hash(password, 10));
    db.deleteUserSessions(account.id, null);
    res.setHeader("Set-Cookie", clearCookie());
    res.json({ ok: true });
  }));

  app.get("/api/me", requireUser, function (req, res) {
    res.json({ user: db.publicUser(req.user) });
  });

  app.post("/api/password", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    const matches = await bcrypt.compare(String(body.currentPassword || ""), req.user.passwordHash);
    if (!matches) throw new HttpError(400, "The current password is not right.");
    const password = checkPassword(body.password);
    if (body.password !== body.confirmPassword) throw new HttpError(400, "Those passwords do not match.");
    db.setPassword(req.user.id, await bcrypt.hash(password, 10));
    db.deleteUserSessions(req.user.id, req.sessionToken);
    res.json({ ok: true, message: "Password saved. Other devices need to join again." });
  }));

  app.post("/api/recovery/rotate", requireUser, wrap(async function (req, res) {
    const matches = await bcrypt.compare(String((req.body || {}).currentPassword || ""), req.user.passwordHash);
    if (!matches) throw new HttpError(400, "The current password is not right.");
    const recoveryKey = makeRecoveryKey();
    db.setRecovery(req.user.id, hashRecovery(recoveryKey));
    res.json({ recoveryKey: recoveryKey });
  }));

  app.get("/api/devices", requireUser, function (req, res) {
    const owner = db.firstUser();
    let devices;
    if (owner && owner.id === req.user.id) devices = db.allDevices();
    else {
      devices = db.listDevices(req.user.id);
      if (owner) devices = devices.concat(db.listDevices(owner.id));
    }
    const presented = devices.map(function (device) {
      return presentDevice(device, req.user.id);
    });
    presented.sort(function (a, b) {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      if (a.role !== b.role) return a.role === "home" ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
    res.json({ devices: presented });
  });

  app.post("/api/devices/rename", requireUser, function (req, res) {
    const body = req.body || {};
    const device = ownedDevice(req.user, body.deviceId);
    const name = cleanDeviceName(body.name);
    db.renameDevice(device.id, name);
    if (device.role === "linked") hub.notifyRename(device.id, name);
    if (device.role === "home" && ctx.getConfig().deviceId === device.id) {
      const config = Object.assign({}, ctx.getConfig(), { deviceName: name });
      ctx.setConfig(config);
    }
    res.json({ device: presentDevice(db.getDevice(device.id), req.user.id) });
  });

  app.post("/api/devices/remove", requireUser, function (req, res) {
    const device = ownedDevice(req.user, (req.body || {}).deviceId);
    if (device.role === "home") {
      throw new HttpError(400, "The main device stays while ServerOS is running here.");
    }
    hub.closeDevice(device.id, true);
    db.removeDevice(device.id);
    res.json({ ok: true });
  });

  app.get("/api/files", requireUser, wrap(async function (req, res) {
    const rel = String(req.query.path || "");
    const result = await actOnDevice(req.user, req.query.deviceId, function (device, root) {
      return storage.list(root, rel);
    }, function (device) {
      return hub.ask(device.id, { op: "list", path: rel }, 30000);
    });
    res.json(result);
  }));

  app.post("/api/folder", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    const created = await actOnDevice(req.user, body.deviceId, function (device, root) {
      return storage.mkdir(root, body.path || "", body.name);
    }, function (device) {
      return hub.ask(device.id, { op: "mkdir", path: body.path || "", name: body.name }, 30000);
    }, true);
    invalidateUsage(req.user.id);
    res.json({ entry: created });
  }));

  app.post("/api/note", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    if (typeof body.content !== "string") throw new HttpError(400, "Write something in the note.");
    if (body.content.length > 200000) {
      throw new HttpError(400, "That note is too long. Upload it as a file instead.");
    }
    let name = storage.safeBaseName(body.name || "Note");
    if (!path.extname(name)) name += ".txt";
    const buffer = Buffer.from(body.content, "utf8");
    const entry = await actOnDevice(req.user, body.deviceId, function (device, root) {
      return storage.writeNewFile(root, body.path || "", name, buffer);
    }, async function (device) {
      const tmp = path.join(ctx.tmpDir, "note-" + Date.now() + "-" + Math.random().toString(16).slice(2));
      fs.writeFileSync(tmp, buffer);
      try {
        return await hub.upload(device.id, body.path || "", name, tmp);
      } finally {
        fs.unlink(tmp, function () {});
      }
    }, true);
    invalidateUsage(req.user.id);
    res.json({ entry: entry });
  }));

  app.post("/api/rename", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    const entry = await actOnDevice(req.user, body.deviceId, function (device, root) {
      return storage.rename(root, body.path || "", body.name);
    }, function (device) {
      return hub.ask(device.id, { op: "rename", path: body.path || "", name: body.name }, 30000);
    }, true);
    res.json({ entry: entry });
  }));

  app.post("/api/delete", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    await actOnDevice(req.user, body.deviceId, function (device, root) {
      return storage.remove(root, body.path || "");
    }, function (device) {
      return hub.ask(device.id, { op: "delete", path: body.path || "" }, 120000);
    }, true);
    invalidateUsage(req.user.id);
    res.json({ ok: true });
  }));

  app.post("/api/upload", requireUser, ctx.upload.array("files", 100), wrap(async function (req, res) {
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, "Choose a file to upload.");
    const parent = String((req.body && req.body.path) || "");
    const rels = asArray(req.body && req.body.relpaths);
    const device = ownedDevice(req.user, req.body && req.body.deviceId);
    const saved = [];
    try {
      for (let i = 0; i < files.length; i++) {
        let relative = files[i].originalname || "file";
        if (rels[i]) {
          try {
            relative = storage.safeRelative(rels[i]);
          } catch (err) {
            relative = storage.safeBaseName(files[i].originalname || "file");
          }
        } else {
          relative = storage.safeBaseName(relative);
        }
        const slash = relative.lastIndexOf("/");
        const folderPart = slash === -1 ? "" : relative.slice(0, slash);
        const baseName = slash === -1 ? relative : relative.slice(slash + 1);
        const dirRel = storage.joinPosix(parent, folderPart);
        if (device.role === "home") {
          saved.push(storage.saveUpload(homeRoot(req.user.id), dirRel, baseName, files[i].path));
        } else {
          if (!hub.isOnline(device.id)) {
            throw new HttpError(409, device.name + " is offline. Turn it on and leave ServerOS open there.");
          }
          saved.push(await hub.upload(device.id, dirRel, baseName, files[i].path));
          fs.unlink(files[i].path, function () {});
        }
      }
    } catch (err) {
      cleanupTemps(files);
      throw err;
    }
    invalidateUsage(req.user.id);
    res.json({ saved: saved });
  }));

  app.get("/api/download", requireUser, wrap(async function (req, res) {
    const rel = String(req.query.path || "");
    const inline = req.query.inline === "1" || req.query.inline === "true";
    const device = visibleDevice(req.user, req.query.deviceId);
    if (device.role === "home") {
      const filePath = storage.resolveExistingFile(homeRoot(device.userId), rel);
      storage.pipeFile(req, res, filePath, path.basename(filePath), inline);
      return;
    }
    if (!hub.isOnline(device.id)) {
      throw new HttpError(409, device.name + " is offline. Turn it on and leave ServerOS open there.");
    }
    await hub.download(device.id, rel, res, inline);
  }));

  app.post("/api/share", requireUser, wrap(async function (req, res) {
    const body = req.body || {};
    const device = ownedDevice(req.user, body.deviceId);
    const rel = String(body.path || "");
    if (device.role === "home") storage.resolveExistingFile(homeRoot(device.userId), rel);
    else {
      const listed = await hub.ask(device.id, { op: "list", path: rel.indexOf("/") === -1 ? "" : rel.slice(0, rel.lastIndexOf("/")) }, 30000);
      const name = rel.indexOf("/") === -1 ? rel : rel.slice(rel.lastIndexOf("/") + 1);
      const found = (listed.entries || []).some(function (entry) {
        return entry.name === name && entry.kind === "file";
      });
      if (!found) throw new HttpError(404, "That file was not found.");
    }
    let hours = parseInt(body.hours, 10);
    if (hours !== 1 && hours !== 24 && hours !== 168) hours = 24;
    const share = db.createShare({
      userId: req.user.id,
      deviceId: device.id,
      path: rel,
      name: rel.slice(rel.lastIndexOf("/") + 1),
      expiresAt: Date.now() + hours * 3600000
    });
    res.json({
      token: share.token,
      url: shareUrl(share.token),
      expiresAt: share.expiresAt,
      name: share.name
    });
  }));

  app.get("/api/shares", requireUser, function (req, res) {
    res.json({
      shares: db.listShares(req.user.id).map(function (share) {
        const device = db.getDevice(share.deviceId);
        return {
          token: share.token,
          name: share.name,
          path: share.path,
          deviceName: device ? device.name : "Device",
          expiresAt: share.expiresAt,
          url: shareUrl(share.token)
        };
      })
    });
  });

  app.post("/api/shares/revoke", requireUser, function (req, res) {
    db.deleteShare((req.body || {}).token, req.user.id);
    res.json({ ok: true });
  });

  app.get("/api/connect-info", requireUser, wrap(async function (req, res) {
    const port = ctx.getPort();
    const urls = lanIps().map(function (ip) { return "http://" + ip + ":" + port; });
    const primary = urls[0] || ("http://127.0.0.1:" + port);
    let qr = "";
    try {
      qr = await QRCode.toDataURL(primary, {
        margin: 1,
        width: 280,
        color: { dark: "#143532", light: "#fffdf8" }
      });
    } catch (err) {
      qr = "";
    }
    res.json({
      port: port,
      localhost: "http://127.0.0.1:" + port,
      urls: urls,
      primary: primary,
      qr: qr
    });
  }));

  app.get("/s/:token", wrap(async function (req, res) {
    const share = db.getShare(req.params.token);
    if (!share) {
      res.status(404).type("html").send(page("Link expired", "This share link is no longer available."));
      return;
    }
    const device = db.getDevice(share.deviceId);
    if (!device || device.userId !== share.userId) {
      res.status(404).type("html").send(page("File unavailable", "That shared file is no longer on this ServerOS."));
      return;
    }
    if (device.role === "home") {
      try {
        const filePath = storage.resolveExistingFile(homeRoot(share.userId), share.path);
        storage.pipeFile(req, res, filePath, path.basename(filePath), true);
      } catch (err) {
        res.status(404).type("html").send(page("File unavailable", err.message || "That file was not found."));
      }
      return;
    }
    if (!hub.isOnline(device.id)) {
      res.status(409).type("html").send(page(
        device.name + " is offline",
        "This file is stored on " + device.name + ". It can be opened when that device is on and ServerOS is running."
      ));
      return;
    }
    try {
      await hub.download(device.id, share.path, res, true);
    } catch (err) {
      if (!res.headersSent) {
        res.status(err.status || 400).type("html").send(page("File unavailable", err.message || "That file could not be opened."));
      }
    }
  }));

  app.post("/api/setup/join", requireLoopback, wrap(async function (req, res) {
    if (ctx.getMode() === "home") {
      throw new HttpError(400, "This device is already the main ServerOS.");
    }
    const body = req.body || {};
    const homeUrl = normalizeHome(body.homeUrl);
    const login = String(body.login || "").trim();
    const password = String(body.password || "");
    if (!login || !password) throw new HttpError(400, "Enter the email or username, and the password.");
    const deviceName = cleanDeviceName(body.deviceName);
    const result = await postJson(homeUrl + "/api/login", { login: login, password: password, link: true });
    if (result.status !== 200 || !result.json.token) {
      throw new HttpError(400, (result.json && result.json.error) || "Could not log in to that ServerOS.");
    }
    ctx.setConfig({
      mode: "linked",
      homeUrl: homeUrl,
      token: result.json.token,
      deviceName: deviceName,
      deviceId: ctx.getConfig().deviceId || "",
      user: result.json.user || null
    });
    ctx.startLinkedAgent();
    res.json({ ok: true, homeUrl: homeUrl, deviceName: deviceName });
  }));

  app.post("/api/setup/leave", requireLoopback, wrap(async function (req, res) {
    if (ctx.getMode() !== "linked") throw new HttpError(400, "This device is not joined to another ServerOS.");
    const config = ctx.getConfig();
    if (config.token && config.deviceId && config.homeUrl) {
      try {
        await postJson(config.homeUrl + "/api/devices/remove", { deviceId: config.deviceId }, {
          Authorization: "Bearer " + config.token
        }, 4000);
      } catch (err) {}
    }
    ctx.stopLinkedAgent();
    ctx.setConfig(null);
    res.json({ ok: true });
  }));

  function canReadBackups(req, res, next) {
    if (ctx.getMode() === "linked") {
      if (!isLoopback(req)) {
        res.status(403).json({ error: "Open saved backups on this device." });
        return;
      }
      next();
      return;
    }
    requireUser(req, res, next);
  }

  app.get("/api/backup/status", canReadBackups, function (req, res) {
    res.json(ctx.backup.publicStatus());
  });

  app.post("/api/backup/consent", canReadBackups, function (req, res) {
    res.json(ctx.backup.setConsent((req.body || {}).allow === true));
  });

  app.post("/api/backup/android-permission", requireLoopback, function (req, res) {
    res.json(ctx.backup.askAndroid());
  });

  app.post("/api/backup/start", canReadBackups, function (req, res) {
    res.json(ctx.backup.start());
  });

  app.get("/api/backup/library", canReadBackups, function (req, res) {
    const full = String(req.query.full || "") === "1";
    const backups = ctx.backup.library().map(function (item) {
      const copy = {
        deviceId: item.deviceId,
        deviceName: item.deviceName,
        updatedAt: item.updatedAt,
        originalBytes: item.originalBytes,
        storedBytes: item.storedBytes,
        fileCount: item.fileCount
      };
      if (full) copy.files = item.files;
      return copy;
    });
    res.json({ backups: backups });
  });

  app.get("/api/backup/files", canReadBackups, function (req, res) {
    const listed = ctx.backup.browse(req.query.deviceId, req.query.path || "");
    if (!listed) {
      res.status(404).json({ error: "That backup was not found on this device." });
      return;
    }
    res.json(listed);
  });

  app.get("/api/backup/download", canReadBackups, function (req, res) {
    ctx.backup.sendFile(res, req.query.deviceId, req.query.id);
  });

  app.get("/api/backup/blob", requireUser, function (req, res) {
    const found = ctx.backup.rawBlob(req.query.deviceId, req.query.id);
    if (!found) {
      res.status(404).json({ error: "That backup file was not found." });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Backup-Method", found.meta.method);
    fs.createReadStream(found.full).pipe(res);
  });

  app.post("/api/backup/replica/manifest", requireUser, function (req, res) {
    try {
      ctx.backup.saveReplicaManifest((req.body || {}).manifest);
    } catch (err) {
      res.status(400).json({ error: err.message || "That backup list is not valid." });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/backup/replica/blob", requireUser, wrap(async function (req, res) {
    await ctx.backup.saveReplicaBlob(req.headers["x-backup-device"], req.headers["x-backup-name"], req);
    res.json({ ok: true });
  }));
}

module.exports = { mountRoutes };
