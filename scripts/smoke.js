"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const base = process.env.BASE || "http://127.0.0.1:8799";
const root = path.join(__dirname, "..");
const password = "DemoPass123";
let child = null;

function fail(message) {
  console.error("FAIL: " + message);
  if (child) child.kill();
  process.exit(1);
}

function request(method, urlString, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(urlString);
    const headers = Object.assign({}, options.headers || {});
    let payload = null;
    if (options.body) {
      payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(JSON.stringify(options.body));
      if (!options.headers || !options.headers["Content-Type"]) headers["Content-Type"] = "application/json";
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

function assert(cond, message) {
  if (!cond) fail(message);
}

function multipart(fields, file) {
  const boundary = "----serverosboundary";
  const parts = [];
  Object.keys(fields).forEach(function (key) {
    parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + key + "\"\r\n\r\n" + fields[key] + "\r\n"));
  });
  parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + file.name + "\"\r\nContent-Type: text/plain\r\n\r\n"));
  parts.push(file.buffer);
  parts.push(Buffer.from("\r\n--" + boundary + "--\r\n"));
  return { body: Buffer.concat(parts), boundary: boundary };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitFor(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await request("GET", url);
      if (res.status === 200) return res;
    } catch (err) {}
    await sleep(250);
  }
  fail("Timed out waiting for " + url);
}

async function main() {
  const boot = await request("GET", base + "/api/bootstrap");
  assert(boot.status === 200, "bootstrap status " + boot.status);
  assert(boot.json.mode === "setup" || boot.json.accountExists === false || boot.json.mode === "home", "unexpected bootstrap");

  const bad = await request("POST", base + "/api/login", { body: { login: "nobody", password: "wrong-password" } });
  assert(bad.status === 400 || bad.status === 401, "bad login should fail, got " + bad.status);

  const reg = await request("POST", base + "/api/register", {
    body: {
      username: "demo",
      email: "demo@serveros.local",
      password: password,
      confirmPassword: password,
      deviceName: "Test device"
    }
  });
  assert(reg.status === 200, "register failed: " + JSON.stringify(reg.json));
  assert(reg.cookie, "register did not set a cookie");
  assert(reg.json.recoveryKey, "missing recovery key");
  const cookie = reg.cookie;

  const me = await request("GET", base + "/api/me", { cookie: cookie });
  assert(me.status === 200 && me.json.user.username === "demo", "me failed");

  const folder = await request("POST", base + "/api/folder", {
    cookie: cookie,
    body: { path: "", name: "Photos" }
  });
  assert(folder.status === 200, "folder failed " + JSON.stringify(folder.json));

  const note = await request("POST", base + "/api/note", {
    cookie: cookie,
    body: { path: "Photos", name: "hello", content: "hello from serveros" }
  });
  assert(note.status === 200, "note failed " + JSON.stringify(note.json));

  const listed = await request("GET", base + "/api/files?path=" + encodeURIComponent("Photos"), { cookie: cookie });
  assert(listed.status === 200, "list failed");
  const hello = (listed.json.entries || []).filter(function (entry) { return entry.kind === "file"; })[0];
  assert(hello && hello.name.indexOf("hello") === 0, "note was not listed");

  const downloaded = await request("GET", base + "/api/download?path=" + encodeURIComponent(hello.path), { cookie: cookie });
  assert(downloaded.status === 200, "download status " + downloaded.status);
  assert(downloaded.body.toString("utf8") === "hello from serveros", "download body mismatch");

  const attack = await request("GET", base + "/api/download?path=" + encodeURIComponent("../../package.json"), { cookie: cookie });
  assert(attack.status === 400, "path traversal was not blocked: " + attack.status);

  const upload = multipart({ path: "Photos", relpaths: "extra.txt" }, {
    name: "extra.txt",
    buffer: Buffer.from("uploaded")
  });
  const uploaded = await request("POST", base + "/api/upload", {
    cookie: cookie,
    body: upload.body,
    headers: { "Content-Type": "multipart/form-data; boundary=" + upload.boundary }
  });
  assert(uploaded.status === 200, "upload failed " + JSON.stringify(uploaded.json));

  const share = await request("POST", base + "/api/share", {
    cookie: cookie,
    body: { path: hello.path, hours: 1 }
  });
  assert(share.status === 200 && share.json.url, "share failed " + JSON.stringify(share.json));
  const shared = await request("GET", share.json.url);
  assert(shared.status === 200, "shared download failed " + shared.status);
  assert(shared.body.toString("utf8").indexOf("hello from serveros") !== -1, "shared body mismatch");

  const renamed = await request("POST", base + "/api/rename", {
    cookie: cookie,
    body: { path: hello.path, name: "hello-renamed.txt" }
  });
  assert(renamed.status === 200, "rename failed " + JSON.stringify(renamed.json));

  console.log("Main device checks passed.");

  const logs = [];
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      SERVEROS_DIR: path.join(root, ".testrun-b"),
      SERVEROS_PORT: "8899",
      SERVEROS_NO_OPEN: "1"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", function (buf) { logs.push(buf.toString()); });
  child.stderr.on("data", function (buf) { logs.push(buf.toString()); });

  let nodeBase = "";
  for (let i = 0; i < 40 && !nodeBase; i++) {
    const text = logs.join("");
    const match = /On this device:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (match) nodeBase = match[1];
    else await sleep(250);
  }
  assert(nodeBase, "second device did not start: " + logs.join(""));
  await waitFor(nodeBase + "/api/bootstrap");

  const join = await request("POST", nodeBase + "/api/setup/join", {
    body: {
      homeUrl: base,
      login: "demo",
      password: password,
      deviceName: "Second device"
    }
  });
  assert(join.status === 200, "join failed " + JSON.stringify(join.json) + " " + logs.join(""));

  let linked = null;
  for (let i = 0; i < 40 && !linked; i++) {
    const devices = await request("GET", base + "/api/devices", { cookie: cookie });
    linked = (devices.json.devices || []).filter(function (device) {
      return device.role === "linked" && device.online;
    })[0];
    if (!linked) await sleep(250);
  }
  assert(linked, "linked device did not come online: " + logs.join(""));

  const remoteNote = await request("POST", base + "/api/note", {
    cookie: cookie,
    body: { deviceId: linked.id, path: "", name: "from-home", content: "stored on the second device" }
  });
  assert(remoteNote.status === 200, "remote note failed " + JSON.stringify(remoteNote.json));

  const remoteList = await request("GET", base + "/api/files?deviceId=" + encodeURIComponent(linked.id), { cookie: cookie });
  assert(remoteList.status === 200, "remote list failed " + JSON.stringify(remoteList.json));
  const remoteFile = (remoteList.json.entries || []).filter(function (entry) { return entry.kind === "file"; })[0];
  assert(remoteFile, "remote file missing");
  const remoteDownload = await request("GET", base + "/api/download?deviceId=" + encodeURIComponent(linked.id) + "&path=" + encodeURIComponent(remoteFile.path), { cookie: cookie });
  assert(remoteDownload.status === 200, "remote download status " + remoteDownload.status);
  assert(remoteDownload.body.toString("utf8").indexOf("stored on the second device") !== -1, "remote body mismatch");

  child.kill();
  console.log("Linked device checks passed.");
  console.log("All checks passed.");
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  if (child) child.kill();
  process.exit(1);
});
