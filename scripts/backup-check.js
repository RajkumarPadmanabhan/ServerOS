"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const homeDir = path.join(root, ".testrun-home");
const nodeDir = path.join(root, ".testrun-node");
const homeFiles = path.join(root, ".testrun-home-files");
const nodeFiles = path.join(root, ".testrun-node-files");
const password = "DemoPass123";
const children = [];

function fail(message) {
  const err = new Error(message);
  err.serverosFail = true;
  throw err;
}

function request(method, urlString, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(urlString);
    const headers = Object.assign({}, options.headers || {});
    let payload = null;
    if (options.body) {
      payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(JSON.stringify(options.body));
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    if (options.cookie) headers.Cookie = "sid=" + options.cookie;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: headers
    }, function (res) {
      const chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        const buf = Buffer.concat(chunks);
        const raw = res.headers["set-cookie"] || [];
        const list = Array.isArray(raw) ? raw : [raw];
        let sid = options.cookie || "";
        for (let i = 0; i < list.length; i++) {
          const match = /sid=([^;]+)/.exec(list[i] || "");
          if (match) sid = match[1];
        }
        let json = null;
        try { json = JSON.parse(buf.toString("utf8") || "{}"); } catch (err) { json = null; }
        resolve({ status: res.statusCode, json: json, body: buf, cookie: sid });
      });
    });
    req.setTimeout(30000, function () { req.destroy(new Error("timeout " + method + " " + urlString)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function assert(cond, message) {
  if (!cond) fail(message);
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
}

function startServer(env) {
  const logs = [];
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, env, { SERVEROS_NO_OPEN: "1" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout.on("data", function (buf) { logs.push(buf.toString()); });
  child.stderr.on("data", function (buf) { logs.push(buf.toString()); });
  child.logs = logs;
  return child;
}

async function waitUrl(child) {
  for (let i = 0; i < 50; i++) {
    const match = /On this device:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(child.logs.join(""));
    if (match) return match[1];
    if (child.exitCode != null) break;
    await sleep(200);
  }
  fail("server did not start: " + child.logs.join(""));
}

async function waitReady(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await request("GET", url + "/api/bootstrap");
      if (res.status === 200) return res;
    } catch (err) {}
    await sleep(200);
  }
  fail("timed out waiting for " + url);
}

async function waitBackup(url, cookie) {
  let last = null;
  for (let i = 0; i < 80; i++) {
    const res = await request("GET", url + "/api/backup/status", { cookie: cookie });
    assert(res.status === 200, "backup status " + res.status + " " + JSON.stringify(res.json));
    last = res.json;
    if (!last.running && (last.phase === "done" || last.phase === "error")) return last;
    await sleep(250);
  }
  fail("backup did not finish: " + JSON.stringify(last));
}

function fileByName(library, name) {
  const backups = (library && library.backups) || [];
  for (let i = 0; i < backups.length; i++) {
    const files = backups[i].files || [];
    for (let f = 0; f < files.length; f++) {
      const base = String(files[f].path || "").split("/").pop();
      if (base === name) return { backup: backups[i], file: files[f] };
    }
  }
  return null;
}

function cleanup(code) {
  for (let i = 0; i < children.length; i++) {
    try { children[i].kill(); } catch (err) {}
  }
  setTimeout(function () {
    rm(homeDir);
    rm(nodeDir);
    rm(homeFiles);
    rm(nodeFiles);
    process.exit(code);
  }, 400);
}

async function main() {
  rm(homeDir);
  rm(nodeDir);
  rm(homeFiles);
  rm(nodeFiles);
  fs.mkdirSync(homeFiles, { recursive: true });
  fs.mkdirSync(nodeFiles, { recursive: true });
  const note = Buffer.from(("notes stay readable after compression. ").repeat(1200));
  const photo = crypto.randomBytes(256);
  fs.writeFileSync(path.join(homeFiles, "notes.txt"), note);
  fs.writeFileSync(path.join(homeFiles, "photo.bin"), photo);
  fs.writeFileSync(path.join(nodeFiles, "phone-notes.txt"), note);
  fs.writeFileSync(path.join(nodeFiles, "phone-photo.bin"), photo);

  const home = startServer({
    SERVEROS_DIR: homeDir,
    SERVEROS_PORT: "8811",
    SERVEROS_BACKUP_ROOT: homeFiles
  });
  const homeUrl = await waitUrl(home);
  await waitReady(homeUrl);

  const reg = await request("POST", homeUrl + "/api/register", {
    body: {
      username: "demo",
      email: "demo@serveros.local",
      password: password,
      confirmPassword: password,
      deviceName: "Home PC"
    }
  });
  assert(reg.status === 200, "register failed " + JSON.stringify(reg.json));
  const cookie = reg.cookie;

  const denied = await request("POST", homeUrl + "/api/backup/start", { cookie: cookie });
  assert(denied.status === 200 && denied.json.consent === false, "backup started without permission " + JSON.stringify(denied.json));

  const allow = await request("POST", homeUrl + "/api/backup/consent", {
    cookie: cookie,
    body: { allow: true }
  });
  assert(allow.status === 200 && allow.json.consent === true, "consent failed " + JSON.stringify(allow.json));

  const started = await request("POST", homeUrl + "/api/backup/start", { cookie: cookie });
  assert(started.status === 200, "start failed " + JSON.stringify(started.json));
  const homeStatus = await waitBackup(homeUrl, cookie);
  assert(!homeStatus.error, "home backup error: " + homeStatus.error);
  assert(homeStatus.originalBytes > homeStatus.storedBytes, "backup was not smaller: " + homeStatus.originalBytes + " -> " + homeStatus.storedBytes);

  const homeLib = await request("GET", homeUrl + "/api/backup/library?full=1", { cookie: cookie });
  const homeNote = fileByName(homeLib.json, "notes.txt");
  const homePhoto = fileByName(homeLib.json, "photo.bin");
  assert(homeNote && homePhoto, "home backup files missing " + JSON.stringify(homeLib.json));
  assert(homeNote.file.method === "gzip" && homeNote.file.stored < homeNote.file.size, "notes were not compressed");
  const gotNote = await request("GET", homeUrl + "/api/backup/download?deviceId=" + encodeURIComponent(homeNote.backup.deviceId) + "&id=" + encodeURIComponent(homeNote.file.id), { cookie: cookie });
  const gotPhoto = await request("GET", homeUrl + "/api/backup/download?deviceId=" + encodeURIComponent(homePhoto.backup.deviceId) + "&id=" + encodeURIComponent(homePhoto.file.id), { cookie: cookie });
  assert(gotNote.body.equals(note), "home notes changed after compress");
  assert(gotPhoto.body.equals(photo), "home photo changed after compress");
  console.log("Home backup is smaller and lossless.");

  const node = startServer({
    SERVEROS_DIR: nodeDir,
    SERVEROS_PORT: "8812",
    SERVEROS_BACKUP_ROOT: nodeFiles
  });
  const nodeUrl = await waitUrl(node);
  await waitReady(nodeUrl);
  const join = await request("POST", nodeUrl + "/api/setup/join", {
    body: { homeUrl: homeUrl, login: "demo", password: password, deviceName: "Phone" }
  });
  assert(join.status === 200, "join failed " + JSON.stringify(join.json) + " " + node.logs.join(""));

  let linked = null;
  for (let i = 0; i < 40 && !linked; i++) {
    const devices = await request("GET", homeUrl + "/api/devices", { cookie: cookie });
    linked = (devices.json.devices || []).filter(function (device) {
      return device.role === "linked" && device.online;
    })[0];
    if (!linked) await sleep(250);
  }
  assert(linked, "phone did not come online: " + node.logs.join(""));

  let pulled = null;
  for (let i = 0; i < 40 && !pulled; i++) {
    const lib = await request("GET", nodeUrl + "/api/backup/library?full=1");
    pulled = fileByName(lib.json, "notes.txt");
    if (!pulled) await sleep(300);
  }
  assert(pulled, "phone did not receive the computer backup: " + node.logs.join(""));
  const fromPhone = await request("GET", nodeUrl + "/api/backup/download?deviceId=" + encodeURIComponent(pulled.backup.deviceId) + "&id=" + encodeURIComponent(pulled.file.id));
  assert(fromPhone.body.equals(note), "copy on the phone does not match the computer file");
  console.log("Phone stored a copy of the computer backup.");

  const nodeAllow = await request("POST", nodeUrl + "/api/backup/consent", { body: { allow: true } });
  assert(nodeAllow.status === 200 && nodeAllow.json.consent === true, "phone consent failed " + JSON.stringify(nodeAllow.json));
  const nodeStart = await request("POST", nodeUrl + "/api/backup/start");
  assert(nodeStart.status === 200, "phone backup start failed " + JSON.stringify(nodeStart.json));
  const nodeStatus = await waitBackup(nodeUrl);
  assert(!nodeStatus.error, "phone backup error: " + nodeStatus.error + " " + node.logs.join(""));
  assert(nodeStatus.copiedToOthers === true, "phone backup was not copied to the computer: " + JSON.stringify(nodeStatus));

  try { node.kill(); } catch (err) {}
  await sleep(500);
  const homeAfter = await request("GET", homeUrl + "/api/backup/library?full=1", { cookie: cookie });
  const phoneNote = fileByName(homeAfter.json, "phone-notes.txt");
  const phonePhoto = fileByName(homeAfter.json, "phone-photo.bin");
  assert(phoneNote && phonePhoto, "computer is missing the phone backup " + JSON.stringify(homeAfter.json));
  const phoneBytes = await request("GET", homeUrl + "/api/backup/download?deviceId=" + encodeURIComponent(phoneNote.backup.deviceId) + "&id=" + encodeURIComponent(phoneNote.file.id), { cookie: cookie });
  const phonePhotoBytes = await request("GET", homeUrl + "/api/backup/download?deviceId=" + encodeURIComponent(phonePhoto.backup.deviceId) + "&id=" + encodeURIComponent(phonePhoto.file.id), { cookie: cookie });
  assert(phoneBytes.body.equals(note), "phone notes changed when the phone was off");
  assert(phonePhotoBytes.body.equals(photo), "phone photo changed when the phone was off");
  console.log("Computer can open the phone backup after the phone is off.");

  try { home.kill(); } catch (err) {}
  await sleep(400);
  const nodeAgain = startServer({
    SERVEROS_DIR: nodeDir,
    SERVEROS_PORT: "8812",
    SERVEROS_BACKUP_ROOT: nodeFiles
  });
  const nodeUrl2 = await waitUrl(nodeAgain);
  await waitReady(nodeUrl2);
  const offline = await request("GET", nodeUrl2 + "/api/backup/library?full=1");
  const still = fileByName(offline.json, "notes.txt");
  assert(still, "computer backup disappeared from the phone");
  const stillBytes = await request("GET", nodeUrl2 + "/api/backup/download?deviceId=" + encodeURIComponent(still.backup.deviceId) + "&id=" + encodeURIComponent(still.file.id));
  assert(stillBytes.body.equals(note), "computer notes changed when the computer was off");
  console.log("Phone can open the computer backup after the computer is off.");
  console.log("All backup checks passed.");
  cleanup(0);
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  cleanup(1);
});
