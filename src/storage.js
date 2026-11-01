"use strict";

const fs = require("fs");
const path = require("path");
const { HttpError, contentDisposition } = require("./util");

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".apk": "application/vnd.android.package-archive"
};

const INLINE_EXT = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".gif": true,
  ".webp": true,
  ".pdf": true,
  ".txt": true,
  ".md": true,
  ".log": true,
  ".csv": true,
  ".json": true,
  ".mp3": true,
  ".wav": true,
  ".m4a": true,
  ".ogg": true,
  ".mp4": true,
  ".webm": true
};

function assertSafePart(part) {
  if (!part || part === "." || part === "..") {
    throw new HttpError(400, "That path is not allowed.");
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(part)) {
    throw new HttpError(400, "That name has a character this device cannot store.");
  }
  if (/[. ]$/.test(part)) {
    throw new HttpError(400, "That name cannot end with a space or a dot.");
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part)) {
    throw new HttpError(400, "That name is reserved by Windows. Try another name.");
  }
  if (part.length > 120) throw new HttpError(400, "That name is too long.");
}

function partsFrom(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.length > 200) throw new HttpError(400, "That path is too long.");
  if (!clean) return [];
  const parts = clean.split("/");
  for (let i = 0; i < parts.length; i++) assertSafePart(parts[i]);
  return parts;
}

function resolveSafe(root, rel) {
  const parts = partsFrom(rel);
  const rootResolved = path.resolve(root);
  const target = parts.length ? path.resolve.apply(path, [rootResolved].concat(parts)) : rootResolved;
  const relative = path.relative(rootResolved, target);
  if (relative.split(path.sep).indexOf("..") !== -1 || path.isAbsolute(relative)) {
    throw new HttpError(400, "That path is not allowed.");
  }
  return target;
}

function safeBaseName(name) {
  let base = path.basename(String(name || "file"));
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!base || base === "." || base === "..") base = "file";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = base + "_file";
  if (base.length > 120) {
    const ext = path.extname(base);
    const keep = 120 - ext.length;
    base = (keep > 0 ? base.slice(0, keep) : "file") + ext;
  }
  return base || "file";
}

function safeRelative(rel) {
  const parts = partsFrom(rel);
  if (!parts.length) throw new HttpError(400, "Missing file name.");
  return parts.map(safeBaseName).join("/");
}

function joinPosix(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  return String(a).replace(/\/+$/, "") + "/" + String(b).replace(/^\/+/, "");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 1; i <= 500; i++) {
    const next = stem + " (" + i + ")" + ext;
    if (!fs.existsSync(path.join(dir, next))) return next;
  }
  throw new HttpError(400, "Too many files already use that name.");
}

function busyMessage(err, fallback) {
  if (err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) {
    return "That file is busy. Close it in other programs and try again.";
  }
  return fallback;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    try {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } catch (copyErr) {
      throw new HttpError(400, busyMessage(copyErr, "Could not save that file."));
    }
  }
}

function entryFor(rel, full, st) {
  return {
    name: path.basename(full),
    path: rel,
    kind: st.isDirectory() ? "folder" : "file",
    size: st.isDirectory() ? 0 : st.size,
    modified: st.mtimeMs
  };
}

function list(root, rel) {
  ensureDir(root);
  const dir = resolveSafe(root, rel);
  if (!fs.existsSync(dir)) {
    if (!rel) ensureDir(dir);
    else throw new HttpError(404, "That folder was not found.");
  }
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new HttpError(400, "That is a file, not a folder.");
  const names = fs.readdirSync(dir);
  const entries = [];
  for (let i = 0; i < names.length; i++) {
    if (names[i].charAt(0) === ".") continue;
    const full = path.join(dir, names[i]);
    let itemStat;
    try {
      itemStat = fs.statSync(full);
    } catch (err) {
      continue;
    }
    const child = rel ? rel + "/" + names[i] : names[i];
    entries.push(entryFor(child, full, itemStat));
  }
  entries.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return { path: rel || "", entries: entries };
}

function mkdir(root, rel, name) {
  if (!String(name || "").trim()) throw new HttpError(400, "Type a folder name.");
  const safeName = safeBaseName(name);
  assertSafePart(safeName);
  const parent = resolveSafe(root, rel);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new HttpError(404, "That folder was not found.");
  }
  const dest = path.join(parent, safeName);
  if (fs.existsSync(dest)) {
    const existing = fs.statSync(dest);
    if (existing.isDirectory()) return entryFor(joinPosix(rel, safeName), dest, existing);
    throw new HttpError(400, "That name is already used by a file.");
  }
  fs.mkdirSync(dest);
  return entryFor(joinPosix(rel, safeName), dest, fs.statSync(dest));
}

function remove(root, rel) {
  if (!rel) throw new HttpError(400, "Choose a file or folder inside ServerOS.");
  const target = resolveSafe(root, rel);
  if (!fs.existsSync(target)) throw new HttpError(404, "That was already removed.");
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    throw new HttpError(400, busyMessage(err, "Could not delete that."));
  }
  return { ok: true };
}

function rename(root, rel, newName) {
  if (!rel) throw new HttpError(400, "Choose a file or folder first.");
  if (!String(newName || "").trim()) throw new HttpError(400, "Type a new name.");
  const safeName = safeBaseName(newName);
  assertSafePart(safeName);
  const target = resolveSafe(root, rel);
  if (!fs.existsSync(target)) throw new HttpError(404, "That was not found.");
  const dest = path.join(path.dirname(target), safeName);
  const relative = path.relative(path.resolve(root), dest);
  if (relative.split(path.sep).indexOf("..") !== -1 || path.isAbsolute(relative)) {
    throw new HttpError(400, "That name is not allowed.");
  }
  if (path.resolve(dest) !== path.resolve(target) && fs.existsSync(dest)) {
    throw new HttpError(400, "That name is already used.");
  }
  try {
    if (path.resolve(dest) !== path.resolve(target)) fs.renameSync(target, dest);
  } catch (err) {
    throw new HttpError(400, busyMessage(err, "Could not rename that."));
  }
  const parent = rel.indexOf("/") === -1 ? "" : rel.slice(0, rel.lastIndexOf("/"));
  return entryFor(joinPosix(parent, safeName), dest, fs.statSync(dest));
}

function saveUpload(root, dirRel, originalName, tempPath) {
  const safeName = safeBaseName(originalName);
  assertSafePart(safeName);
  const dirAbs = resolveSafe(root, dirRel || "");
  ensureDir(dirAbs);
  const finalName = uniqueName(dirAbs, safeName);
  const dest = path.join(dirAbs, finalName);
  moveFile(tempPath, dest);
  return entryFor(joinPosix(dirRel || "", finalName), dest, fs.statSync(dest));
}

function writeNewFile(root, dirRel, name, buffer) {
  const safeName = safeBaseName(name);
  assertSafePart(safeName);
  const dirAbs = resolveSafe(root, dirRel || "");
  ensureDir(dirAbs);
  const finalName = uniqueName(dirAbs, safeName);
  const dest = path.join(dirAbs, finalName);
  fs.writeFileSync(dest, buffer);
  return entryFor(joinPosix(dirRel || "", finalName), dest, fs.statSync(dest));
}

function resolveExistingFile(root, rel) {
  if (!rel) throw new HttpError(400, "Choose a file.");
  const target = resolveSafe(root, rel);
  if (!fs.existsSync(target)) throw new HttpError(404, "That file was not found.");
  const st = fs.statSync(target);
  if (st.isDirectory()) throw new HttpError(400, "That is a folder. Open it and choose a file.");
  return target;
}

function usage(root) {
  let bytes = 0;
  let files = 0;
  if (!fs.existsSync(root)) return { bytes: 0, files: 0 };
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = fs.readdirSync(current);
    } catch (err) {
      continue;
    }
    for (let i = 0; i < names.length; i++) {
      const full = path.join(current, names[i]);
      let st;
      try {
        st = fs.statSync(full);
      } catch (err) {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else {
        bytes += st.size;
        files += 1;
      }
    }
  }
  return { bytes: bytes, files: files };
}

function mimeFor(name, inline) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (inline && (ext === ".json" || ext === ".csv" || ext === ".md" || ext === ".log" || ext === ".txt")) {
    return "text/plain; charset=utf-8";
  }
  return MIME[ext] || "application/octet-stream";
}

function canInline(name) {
  return !!INLINE_EXT[path.extname(String(name || "")).toLowerCase()];
}

function pipeFile(req, res, filePath, downloadName, inline) {
  const st = fs.statSync(filePath);
  const allowInline = !!(inline && canInline(downloadName));
  const total = st.size;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Accept-Ranges", allowInline ? "bytes" : "none");
  res.setHeader("Content-Type", mimeFor(downloadName, allowInline));
  res.setHeader("Content-Disposition", contentDisposition(downloadName, allowInline));

  const range = allowInline ? req.headers.range : "";
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || total === 0) {
      res.status(416);
      res.setHeader("Content-Range", "bytes */" + total);
      res.end();
      return;
    }
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.status(416);
      res.setHeader("Content-Range", "bytes */" + total);
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", String(total));
  if (total === 0) {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

module.exports = {
  list: list,
  mkdir: mkdir,
  remove: remove,
  rename: rename,
  saveUpload: saveUpload,
  writeNewFile: writeNewFile,
  resolveExistingFile: resolveExistingFile,
  usage: usage,
  mimeFor: mimeFor,
  canInline: canInline,
  safeBaseName: safeBaseName,
  safeRelative: safeRelative,
  joinPosix: joinPosix,
  pipeFile: pipeFile
};
