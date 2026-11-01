"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function insideRoundRect(nx, ny, left, top, right, bottom, radius) {
  if (nx < left || nx > right || ny < top || ny > bottom) return false;
  const r = radius;
  const corners = [
    [left + r, top + r, nx < left + r && ny < top + r],
    [right - r, top + r, nx > right - r && ny < top + r],
    [left + r, bottom - r, nx < left + r && ny > bottom - r],
    [right - r, bottom - r, nx > right - r && ny > bottom - r]
  ];
  for (let i = 0; i < corners.length; i++) {
    if (!corners[i][2]) continue;
    const dx = nx - corners[i][0];
    const dy = ny - corners[i][1];
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function pixel(x, y, size) {
  const nx = x / (size - 1);
  const ny = y / (size - 1);
  const teal = [15, 110, 107];
  const cream = [255, 253, 248];
  if (!insideRoundRect(nx, ny, 0.08, 0.08, 0.92, 0.92, 0.18)) return teal;
  if (!insideRoundRect(nx, ny, 0.22, 0.2, 0.78, 0.8, 0.08)) return teal;
  const lines = [0.4, 0.52, 0.64];
  for (let i = 0; i < lines.length; i++) {
    if (Math.abs(ny - lines[i]) < 0.025 && nx > 0.32 && nx < 0.68) return teal;
  }
  const dx = nx - 0.74;
  const dy = ny - 0.28;
  if (dx * dx + dy * dy < 0.004) return [31, 122, 77];
  return cream;
}

function png(size) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const color = pixel(x, y, size);
      const i = row + 1 + x * 3;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function writeIcons(publicDir) {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "icon-192.png"), png(192));
  fs.writeFileSync(path.join(publicDir, "icon-512.png"), png(512));
}

module.exports = { writeIcons };
