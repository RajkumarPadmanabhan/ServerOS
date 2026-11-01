"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { newId } = require("./util");

function empty() {
  return { users: [], sessions: [], devices: [], shares: [] };
}

function createDb(file) {
  let data = empty();
  let timer = null;
  let dirty = false;

  function saveNow() {
    dirty = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (dirty) saveNow();
    }, 800);
    if (timer.unref) timer.unref();
  }

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      data = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        shares: Array.isArray(parsed.shares) ? parsed.shares : []
      };
    } catch (err) {
      try {
        fs.copyFileSync(file, file + ".broken-" + Date.now());
      } catch (copyErr) {}
      data = empty();
      saveNow();
    }
  }

  load();

  function firstUser() {
    return data.users[0] || null;
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      owner: !!(firstUser() && firstUser().id === user.id)
    };
  }

  function findUserById(id) {
    for (let i = 0; i < data.users.length; i++) {
      if (data.users[i].id === id) return data.users[i];
    }
    return null;
  }

  function findUserByLogin(login) {
    const needle = String(login || "").trim().toLowerCase();
    for (let i = 0; i < data.users.length; i++) {
      const user = data.users[i];
      if (user.usernameLower === needle || user.emailLower === needle) return user;
    }
    return null;
  }

  function createUser(fields) {
    const user = {
      id: newId(),
      username: fields.username,
      usernameLower: fields.username.toLowerCase(),
      email: fields.email,
      emailLower: fields.email.toLowerCase(),
      passwordHash: fields.passwordHash,
      recoveryHash: fields.recoveryHash,
      createdAt: Date.now()
    };
    data.users.push(user);
    saveNow();
    return user;
  }

  function setPassword(userId, passwordHash) {
    const user = findUserById(userId);
    if (!user) return;
    user.passwordHash = passwordHash;
    saveNow();
  }

  function setRecovery(userId, recoveryHash) {
    const user = findUserById(userId);
    if (!user) return;
    user.recoveryHash = recoveryHash;
    saveNow();
  }

  function createSession(userId, kind) {
    const days = kind === "link" ? 180 : 30;
    const session = {
      token: crypto.randomBytes(32).toString("hex"),
      userId: userId,
      kind: kind || "browser",
      expiresAt: Date.now() + days * 86400000
    };
    data.sessions.push(session);
    saveNow();
    return session;
  }

  function getSession(token) {
    if (!token) return null;
    const now = Date.now();
    const keep = [];
    let found = null;
    for (let i = 0; i < data.sessions.length; i++) {
      const session = data.sessions[i];
      if (session.expiresAt <= now) continue;
      keep.push(session);
      if (session.token === token) found = session;
    }
    if (keep.length !== data.sessions.length) {
      data.sessions = keep;
      markDirty();
    }
    return found;
  }

  function deleteSession(token) {
    data.sessions = data.sessions.filter(function (session) {
      return session.token !== token;
    });
    saveNow();
  }

  function deleteUserSessions(userId, exceptToken) {
    data.sessions = data.sessions.filter(function (session) {
      if (session.userId !== userId) return true;
      return !!(exceptToken && session.token === exceptToken);
    });
    saveNow();
  }

  function createDevice(fields) {
    const device = {
      id: fields.id || newId(),
      userId: fields.userId,
      name: fields.name,
      platform: fields.platform || "Computer",
      role: fields.role === "home" ? "home" : "linked",
      lastSeen: Date.now(),
      createdAt: Date.now()
    };
    data.devices.push(device);
    saveNow();
    return device;
  }

  function listDevices(userId) {
    return data.devices.filter(function (device) {
      return device.userId === userId;
    });
  }

  function getDevice(id) {
    for (let i = 0; i < data.devices.length; i++) {
      if (data.devices[i].id === id) return data.devices[i];
    }
    return null;
  }

  function renameDevice(id, name) {
    const device = getDevice(id);
    if (!device) return null;
    device.name = name;
    saveNow();
    return device;
  }

  function touchDevice(id) {
    const device = getDevice(id);
    if (!device) return;
    device.lastSeen = Date.now();
    markDirty();
  }

  function removeDevice(id) {
    data.devices = data.devices.filter(function (device) {
      return device.id !== id;
    });
    data.shares = data.shares.filter(function (share) {
      return share.deviceId !== id;
    });
    saveNow();
  }

  function homeDevice(userId) {
    const devices = listDevices(userId);
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].role === "home") return devices[i];
    }
    return null;
  }

  function createShare(fields) {
    const share = {
      token: crypto.randomBytes(18).toString("hex"),
      userId: fields.userId,
      deviceId: fields.deviceId,
      path: fields.path,
      name: fields.name,
      expiresAt: fields.expiresAt,
      createdAt: Date.now()
    };
    data.shares.push(share);
    saveNow();
    return share;
  }

  function getShare(token) {
    const now = Date.now();
    for (let i = 0; i < data.shares.length; i++) {
      const share = data.shares[i];
      if (share.token === token && share.expiresAt > now) return share;
    }
    return null;
  }

  function listShares(userId) {
    const now = Date.now();
    return data.shares.filter(function (share) {
      return share.userId === userId && share.expiresAt > now;
    });
  }

  function deleteShare(token, userId) {
    data.shares = data.shares.filter(function (share) {
      if (share.token !== token) return true;
      if (userId && share.userId !== userId) return true;
      return false;
    });
    saveNow();
  }

  return {
    userCount: function () { return data.users.length; },
    firstUser: firstUser,
    publicUser: publicUser,
    findUserById: findUserById,
    findUserByLogin: findUserByLogin,
    createUser: createUser,
    setPassword: setPassword,
    setRecovery: setRecovery,
    createSession: createSession,
    getSession: getSession,
    deleteSession: deleteSession,
    deleteUserSessions: deleteUserSessions,
    createDevice: createDevice,
    listDevices: listDevices,
    allDevices: function () { return data.devices.slice(); },
    getDevice: getDevice,
    renameDevice: renameDevice,
    touchDevice: touchDevice,
    removeDevice: removeDevice,
    homeDevice: homeDevice,
    createShare: createShare,
    getShare: getShare,
    listShares: listShares,
    deleteShare: deleteShare,
    flush: saveNow
  };
}

module.exports = { createDb };
