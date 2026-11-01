"use strict";

const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const VERSION = "1.0.0";

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || "";
}

function isLoopback(req) {
  const ip = clientIp(req);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function lanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family !== "IPv4" && net.family !== 4) return;
      if (net.internal) return;
      ips.push(net.address);
    });
  });
  function score(ip) {
    if (ip.indexOf("192.168.") === 0) return 30;
    if (ip.indexOf("10.") === 0) return 20;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 20;
    return 1;
  }
  ips.sort(function (a, b) {
    return score(b) - score(a);
  });
  return ips;
}

function platformName() {
  const prefix = process.env.PREFIX || "";
  if (prefix.indexOf("com.termux") !== -1) return "Android";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "Mac";
  if (process.platform === "linux") return "Linux";
  return "Computer";
}

function defaultDeviceName() {
  const raw = os.hostname() || "My device";
  const clean = String(raw).replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 40);
  return clean || "My device";
}

function cleanDeviceName(name) {
  const clean = String(name || "").replace(/[<>:"/\\|?*\r\n]/g, "").trim().slice(0, 40);
  return clean || defaultDeviceName();
}

function makeOwnerCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function formatOwnerCode(code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length !== 6) return digits;
  return digits.slice(0, 3) + " " + digits.slice(3);
}

function codesMatch(a, b) {
  const left = Buffer.from(String(a || "").replace(/\D/g, ""));
  const right = Buffer.from(String(b || "").replace(/\D/g, ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf("=");
    if (idx === -1) continue;
    if (parts[i].slice(0, idx).trim() === name) {
      return decodeURIComponent(parts[i].slice(idx + 1).trim());
    }
  }
  return "";
}

function sessionCookie(token, maxAgeSec) {
  const expires = new Date(Date.now() + maxAgeSec * 1000).toUTCString();
  return "sid=" + token + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" + maxAgeSec + "; Expires=" + expires;
}

function clearCookie() {
  return "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

function bearer(req) {
  const header = req.headers.authorization || "";
  if (header.indexOf("Bearer ") === 0) return header.slice(7).trim();
  return "";
}

function contentDisposition(name, inline) {
  const type = inline ? "inline" : "attachment";
  const ascii = String(name).replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return type + '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function hashRecovery(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return crypto.createHash("sha256").update("serveros-recovery-v1:" + normalized).digest("hex");
}

function recoveryMatches(key, storedHash) {
  const next = Buffer.from(hashRecovery(key));
  const prev = Buffer.from(String(storedHash || ""));
  if (!storedHash || next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

function makeRecoveryKey() {
  return crypto.randomBytes(8).toString("hex").toUpperCase().replace(/(.{4})/g, "$1-").replace(/-$/, "");
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

function validUsername(username) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(username);
}

function normalizeHome(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new HttpError(400, "Enter the address of your main ServerOS.");
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new HttpError(400, "That address does not look right. Example: http://192.168.1.20:8787");
  }
  if (url.protocol !== "http:") {
    throw new HttpError(400, "Use the http:// address shown on your main device.");
  }
  if (!url.port) url.port = "8787";
  return url.origin;
}

function postJson(urlString, body, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try {
      u = new URL(urlString);
    } catch (err) {
      reject(new HttpError(400, "That address does not look right."));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body || {});
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: Object.assign({
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }, headers || {})
    }, function (res) {
      const chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = {};
        try {
          json = JSON.parse(text || "{}");
        } catch (err) {
          json = { error: "The other ServerOS sent an unexpected reply." };
        }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.setTimeout(timeoutMs || 20000, function () {
      req.destroy(new Error("timeout"));
    });
    req.on("error", function () {
      reject(new HttpError(400, "Could not reach that ServerOS. Check the address and that it is still open."));
    });
    req.write(payload);
    req.end();
  });
}

function openBrowser(url) {
  if (process.env.SERVEROS_NO_OPEN === "1") return;
  let cmd = 'xdg-open "' + url + '"';
  if (process.platform === "win32") cmd = 'start "" "' + url + '"';
  if (process.platform === "darwin") cmd = 'open "' + url + '"';
  exec(cmd, { windowsHide: true }, function () {});
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let url;
  try {
    url = new URL(origin);
  } catch (err) {
    throw new HttpError(403, "That request was blocked.");
  }
  if (url.host !== req.headers.host) throw new HttpError(403, "That request was blocked.");
}

function bestOrigin(port) {
  const ips = lanIps();
  if (ips.length) return "http://" + ips[0] + ":" + port;
  return "http://127.0.0.1:" + port;
}

module.exports = {
  HttpError,
  VERSION,
  clientIp,
  isLoopback,
  lanIps,
  platformName,
  defaultDeviceName,
  cleanDeviceName,
  makeOwnerCode,
  formatOwnerCode,
  codesMatch,
  readCookie,
  sessionCookie,
  clearCookie,
  bearer,
  contentDisposition,
  escapeHtml,
  readJson,
  writeJson,
  newId,
  hashRecovery,
  recoveryMatches,
  makeRecoveryKey,
  validEmail,
  validUsername,
  normalizeHome,
  postJson,
  openBrowser,
  assertSameOrigin,
  bestOrigin
};
