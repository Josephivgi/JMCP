"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const assets = path.join(root, "app", "assets");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("the JM PNG is a 512px RGBA image", () => {
  const png = fs.readFileSync(path.join(assets, "icon.png"));
  assert.deepEqual(png.subarray(0, 8), pngSignature);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[25], 6);
});

test("the Windows icon includes every supported size", () => {
  const ico = fs.readFileSync(path.join(assets, "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(4), sizes.length);
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, sizes[index]);
    assert.equal(ico[entry + 1] || 256, sizes[index]);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + sizes.length * 16);
    assert.ok(length > 0 && offset + length <= ico.length);
    assert.deepEqual(ico.subarray(offset, offset + 8), pngSignature);
    assert.equal(ico.readUInt32BE(offset + 16), sizes[index]);
    assert.equal(ico.readUInt32BE(offset + 20), sizes[index]);
  }
});

test("the sidebar uses outlined white JM lettering on dark blue", () => {
  const svg = fs.readFileSync(path.join(assets, "icon.svg"), "utf8");
  assert.match(svg, /fill="#1e3a8a"/);
  assert.match(svg, /rx="204"/);
  assert.match(svg, /fill="#ffffff"/);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.doesNotMatch(svg, /<text|<image|<script|<foreignObject/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.build.win.icon, "app/assets/icon.ico");
});
