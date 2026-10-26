"use strict";

// The installer only ships the packages jmcp-subagents loads at run time, so a
// JMCP install has a few hundred files instead of thousands (each file costs
// time in the setup). This checks that list in package.json still covers
// every package the Agent SDK's entry file loads, and what those depend on.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sub = path.join(root, "servers", "subagents");
const modules = path.join(sub, "node_modules");

// Package names the build includes from servers/subagents/node_modules.
function shipped() {
  const files = require(path.join(root, "package.json")).build.files;
  // Patterns look like "!servers/subagents/node_modules/[@scope/]!(a|b|c)/**":
  // everything except a, b and c is left out.
  const prefix = "!servers/subagents/node_modules/";
  const names = new Set();
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const m = f.slice(prefix.length).match(/^(@[^/]+\/)?!\(([^)]+)\)\/\*\*$/);
    assert.ok(m, "unexpected pattern " + f);
    for (const n of m[2].split("|")) if (!n.startsWith("@")) names.add((m[1] || "") + n);
  }
  return names;
}

// Bare package names a file imports or requires: "zod/v4" -> "zod".
function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = new Set();
  const spec = /(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*)(["'])((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9._\/-]*)?)\1/g;
  for (const m of src.matchAll(spec)) {
    const parts = m[2].split("/");
    const name = m[2].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!require("node:module").builtinModules.includes(name)) out.add(name);
  }
  return out;
}

test("the build ships every package the Agent SDK entry loads", { skip: !fs.existsSync(path.join(modules, "@anthropic-ai", "claude-agent-sdk")) && "run npm ci in servers/subagents first" }, () => {
  const lock = require(path.join(sub, "package-lock.json")).packages;
  const sdkDir = path.join(modules, "@anthropic-ai", "claude-agent-sdk");
  const entry = path.join(sdkDir, require(path.join(sdkDir, "package.json")).main || "sdk.mjs");
  const need = new Set(["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-win32-x64"]);
  const queue = [...imports(entry)];
  while (queue.length) {
    const name = queue.shift();
    if (need.has(name)) continue;
    need.add(name);
    const p = lock["node_modules/" + name];
    assert.ok(p, name + " is loaded by the SDK but not in package-lock.json");
    queue.push(...Object.keys(p.dependencies || {}));
  }
  const have = shipped();
  const missing = [...need].filter((n) => !have.has(n));
  assert.deepStrictEqual(missing, [], "add these to build.files in package.json");
});

test("the server's own code needs nothing beyond the Agent SDK", () => {
  const deps = Object.keys(require(path.join(sub, "package.json")).dependencies || {});
  assert.deepStrictEqual(deps, ["@anthropic-ai/claude-agent-sdk"]);
  for (const f of ["server.cjs", ...fs.readdirSync(path.join(sub, "lib")).map((x) => path.join("lib", x))]) {
    for (const name of imports(path.join(sub, f))) {
      assert.ok(name.startsWith("@anthropic-ai/claude-agent-sdk"), f + " loads " + name + ", which the build does not ship");
    }
  }
});
