"use strict";

// JSON-RPC framing shared by every JMCP server: notifications get no reply,
// bad input gets the right error, batches get one array, unknown tools are
// protocol errors. Runs each real server over stdio on a scratch home.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVERS = ["rules", "instructions", "memory", "skills", "health", "browser", "subagents"];
const dir = (s) => path.join(__dirname, "..", "servers", s);

test("every server has the same lib/rpc.js", () => {
  const first = fs.readFileSync(path.join(dir(SERVERS[0]), "lib", "rpc.js"), "utf8");
  for (const s of SERVERS) assert.strictEqual(fs.readFileSync(path.join(dir(s), "lib", "rpc.js"), "utf8"), first, s);
});

// Send lines, wait until stdin closes and the server exits, return reply lines.
function exchange(server, lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-rpc-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir(server), "server.cjs")], {
      env: Object.assign({}, process.env, { JMCP_HOME: path.join(home, ".jmcp"), USERPROFILE: home, HOME: home }),
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(server + " did not exit"));
    }, 20000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    });
    child.stdin.write(lines.join("\n") + "\n");
    // Give async servers a moment to answer before stdin closes.
    setTimeout(() => child.stdin.end(), 1500);
  });
}

for (const s of SERVERS) {
  test(s + ": notifications, parse errors, invalid requests, batches, unknown tools", async () => {
    const replies = await exchange(s, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "rpc-test" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
      "{",
      "null",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "no/such" }),
      JSON.stringify([{ jsonrpc: "2.0", id: 3, method: "ping" }, { jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", method: "ping" }]),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no-such-tool", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: [1] }),
    ]);
    const byId = (id) => replies.find((r) => !Array.isArray(r) && r.id === id);
    assert.strictEqual(byId(1).result.serverInfo.name, "jmcp-" + s);
    assert.strictEqual(replies.filter((r) => !Array.isArray(r) && r.id === undefined).length, 0, "no reply without an id");
    const nulls = replies.filter((r) => !Array.isArray(r) && r.id === null).map((r) => r.error.code).sort();
    assert.deepStrictEqual(nulls, [-32700, -32600].sort());
    assert.strictEqual(byId(2).error.code, -32601);
    const batch = replies.find(Array.isArray);
    assert.deepStrictEqual(batch.map((r) => r.id).sort(), [3, 4]);
    if (s === "subagents" && process.env.JMCP_SUBAGENT) return;
    assert.strictEqual(byId(5).error.code, -32602);
    assert.strictEqual(byId(6).error.code, -32602);
  });
}

test("an object with no method is an invalid request, not a notification", async () => {
  const { handleLine } = require("../servers/rules/lib/rpc.js");
  assert.deepStrictEqual(await handleLine("{}", {}), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
  const batch = await handleLine("[{}]", {});
  assert.strictEqual(batch[0].error.code, -32600);
  assert.strictEqual(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "x" }), {}), null);
});

test("checkArgs refuses wrong types instead of coercing them", () => {
  const { checkArgs } = require("../servers/rules/lib/rpc.js");
  const schema = { type: "object", properties: { name: { type: "string" }, n: { type: "number" }, on: { type: "boolean" }, level: { type: "string", enum: ["a", "b"] } }, required: ["name"], additionalProperties: false };
  assert.strictEqual(checkArgs(schema, { name: "x", n: 2, on: true, level: "a" }), "");
  assert.match(checkArgs(schema, { name: ["x"] }), /name must be a string/);
  assert.match(checkArgs(schema, {}), /name is required/);
  assert.match(checkArgs(schema, { name: "x", extra: 1 }), /unknown argument extra/);
  assert.match(checkArgs(schema, { name: "x", level: "c" }), /one of a, b/);
  assert.match(checkArgs(schema, { name: "x", n: "2" }), /n must be a number/);
});
