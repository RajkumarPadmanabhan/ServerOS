"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, ".testrun-members");
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
      payload = Buffer.from(JSON.stringify(options.body));
      headers["Content-Type"] = "application/json";
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
    req.setTimeout(20000, function () { req.destroy(new Error("timeout " + method + " " + urlString)); });
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

function startServer() {
  const logs = [];
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      SERVEROS_NO_OPEN: "1",
      SERVEROS_DIR: dataDir,
      SERVEROS_PORT: "8833",
      SERVEROS_BACKUP_ROOT: path.join(dataDir, "backup-root")
    }),
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

function fileByName(entries, name) {
  return (entries || []).filter(function (entry) { return entry.name === name; })[0];
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "backup-root"), { recursive: true });
  const child = startServer();
  const base = await waitUrl(child);
  const owner = await request("POST", base + "/api/register", {
    body: {
      username: "owner",
      email: "owner@serveros.local",
      password: password,
      confirmPassword: password,
      deviceName: "My PC"
    }
  });
  assert(owner.status === 200, "owner register " + owner.status + " " + JSON.stringify(owner.json));
  assert(owner.json.user && owner.json.user.owner === true, "first user is the owner");
  const ownerCookie = owner.cookie;
  const ownerDevice = owner.json.device.id;
  const note = await request("POST", base + "/api/note", {
    cookie: ownerCookie,
    body: { deviceId: ownerDevice, name: "owner-note", content: "owner file" }
  });
  assert(note.status === 200, "owner note " + note.status + " " + JSON.stringify(note.json));

  const duplicate = await request("POST", base + "/api/register", {
    body: {
      username: "owner",
      email: "other@serveros.local",
      password: password,
      confirmPassword: password,
      deviceName: "Dup"
    }
  });
  assert(duplicate.status === 400, "duplicate username should be rejected");

  const member = await request("POST", base + "/api/register", {
    body: {
      username: "friend",
      email: "friend@serveros.local",
      password: password,
      confirmPassword: password,
      deviceName: "Friend phone"
    }
  });
  assert(member.status === 200, "member register " + member.status + " " + JSON.stringify(member.json));
  assert(member.json.user && member.json.user.owner === false, "second user is not the owner");
  const memberCookie = member.cookie;
  const memberDevice = member.json.device.id;
  assert(memberDevice !== ownerDevice, "member has a separate device");

  const devices = await request("GET", base + "/api/devices", { cookie: memberCookie });
  assert(devices.status === 200, "member devices " + devices.status);
  const listed = devices.json.devices || [];
  const seenOwner = listed.filter(function (device) { return device.id === ownerDevice; })[0];
  const seenMine = listed.filter(function (device) { return device.id === memberDevice; })[0];
  assert(seenOwner && seenOwner.shared === true, "member can see the owner's device");
  assert(seenMine && seenMine.mine === true && seenMine.shared === false, "member can see their own device");

  const ownerFiles = await request("GET", base + "/api/files?deviceId=" + encodeURIComponent(ownerDevice), { cookie: memberCookie });
  assert(ownerFiles.status === 200, "member list owner files " + ownerFiles.status + " " + JSON.stringify(ownerFiles.json));
  const ownerEntry = fileByName(ownerFiles.json.entries, "owner-note.txt");
  assert(ownerEntry, "member sees owner-note.txt");
  const download = await request("GET", base + "/api/download?deviceId=" + encodeURIComponent(ownerDevice) + "&path=" + encodeURIComponent(ownerEntry.path), { cookie: memberCookie });
  assert(download.status === 200 && download.body.toString("utf8") === "owner file", "member can download the owner file");

  const blocked = await request("POST", base + "/api/delete", {
    cookie: memberCookie,
    body: { deviceId: ownerDevice, path: ownerEntry.path }
  });
  assert(blocked.status === 403, "member cannot delete the owner file, got " + blocked.status);

  const ownNote = await request("POST", base + "/api/note", {
    cookie: memberCookie,
    body: { deviceId: memberDevice, name: "friend-note", content: "friend file" }
  });
  assert(ownNote.status === 200, "member own note " + ownNote.status + " " + JSON.stringify(ownNote.json));
  const ownFiles = await request("GET", base + "/api/files?deviceId=" + encodeURIComponent(memberDevice), { cookie: memberCookie });
  assert(fileByName(ownFiles.json.entries, "friend-note.txt"), "member sees their own file");
  const stillOwner = await request("GET", base + "/api/files?deviceId=" + encodeURIComponent(ownerDevice), { cookie: memberCookie });
  assert(!fileByName(stillOwner.json.entries, "friend-note.txt"), "member file is not mixed into the owner folder");

  const ownerView = await request("GET", base + "/api/files?deviceId=" + encodeURIComponent(memberDevice), { cookie: ownerCookie });
  assert(ownerView.status === 200 && fileByName(ownerView.json.entries, "friend-note.txt"), "owner can open the other person's files");
  const ownerBlocked = await request("POST", base + "/api/delete", {
    cookie: ownerCookie,
    body: { deviceId: memberDevice, path: "friend-note.txt" }
  });
  assert(ownerBlocked.status === 403, "owner cannot delete another person's file, got " + ownerBlocked.status);

  console.log("Member checks passed.");
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}).finally(function () {
  children.forEach(function (child) {
    try { child.kill(); } catch (err) {}
  });
  setTimeout(function () {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 400);
});
