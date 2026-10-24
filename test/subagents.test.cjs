"use strict";

// The subagents server over real stdio. No agent is started here; the live
// run (a real subagent) is test/live/spawn.cjs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../core/mcp-client.cjs");

const SERVER = path.join(__dirname, "..", "servers", "subagents", "server.cjs");
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-sub-"));

test("lists its tools", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "" } });
  const init = await c.initialize("test");
  assert.strictEqual(init.serverInfo.name, "jmcp-subagents");
  const { tools } = await c.request("tools/list");
  assert.deepStrictEqual(tools.map((t) => t.name), ["providers", "spawn", "list", "wait", "send", "read", "stop"]);
  await c.close();
});

test("inside a subagent it offers no tools", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "droid-1" } });
  const init = await c.initialize("droid");
  assert.match(init.instructions, /cannot start subagents/);
  assert.deepStrictEqual((await c.request("tools/list")).tools, []);
  const r = await c.callTool("spawn", { provider: "claude", task: "x" });
  assert.ok(r.isError);
  await c.close();
});

test("rejects bad spawns before starting anything", async () => {
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: home(), JMCP_SUBAGENT: "" } });
  await c.initialize("test");
  assert.match((await c.callTool("spawn", { provider: "nope", task: "x" })).text, /Unknown provider/);
  assert.match((await c.callTool("spawn", { provider: "claude", task: " " })).text, /task is empty/);
  await assert.rejects(c.callTool("workflow", { steps: [] }), /Unknown tool workflow/);
  assert.match((await c.callTool("wait", { agent: "droid-9" })).text, /No subagent/);
  await c.close();
});

test("frame parser waits for a split header and keeps NDJSON lines before a frame", () => {
  const { createFrameParser, encodeFrame } = require("../servers/subagents/lib/rpc-stdio.js");
  const got = [];
  const p = createFrameParser((m) => got.push(m));
  const f = encodeFrame({ a: 1 });
  p.push(f.slice(0, 10));
  p.push(f.slice(10, 20));
  p.push(f.slice(20));
  p.push(Buffer.from('{"b":2}\n'));
  p.push(Buffer.concat([Buffer.from('{"c":3}\n'), encodeFrame({ d: 4 })]));
  assert.deepStrictEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
});

test("paged file reads stream the asked lines", async () => {
  const { readTextFile } = require("../servers/subagents/lib/acp-fs.js");
  const dir = home();
  const file = path.join(dir, "big.txt");
  // Bigger than the whole-file limit; a paged read still works.
  const line = "x".repeat(1000);
  fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => i + ":" + line).join("\n"));
  await assert.rejects(readTextFile({ path: file }), /too large/);
  const r = await readTextFile({ path: file, line: 3, limit: 2 });
  assert.deepStrictEqual(r.content.split("\n").map((l) => l.split(":")[0]), ["2", "3"]);
  await assert.rejects(readTextFile({ path: file, line: 1 }), /too large/);
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "a\nb\nc");
  assert.strictEqual((await readTextFile({ path: small, line: 2 })).content, "b\nc");
  assert.strictEqual((await readTextFile({ path: small, limit: 1 })).content, "a");
});

test("a released terminal leaves nothing behind", async () => {
  const { AcpClient } = require("../servers/subagents/lib/acp-client.js");
  const c = new AcpClient({ cwd: os.tmpdir() });
  const terminalId = c._createTerminal({ command: process.execPath, args: ["-e", "console.log('hi')"] }).terminalId;
  await c._waitTerminal({ terminalId });
  c._killTerminal({ terminalId }, true);
  assert.strictEqual(c.termProcs.size, 0);
  assert.strictEqual(c.termExits.size, 0);
  assert.strictEqual(c.terminals.has(terminalId), false);
  assert.throws(() => c._terminalOutput({ terminalId }), /Unknown terminal/);
  // Output that arrives after release does not bring the terminal back.
  const late = c._createTerminal({ command: process.execPath, args: ["-e", "setTimeout(() => console.log('late'), 300); setTimeout(() => {}, 2000)"] }).terminalId;
  c._killTerminal({ terminalId: late }, true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(c.terminals.has(late), false);
  await c.stop();
});

test("killTree resolves after the process tree is gone", async () => {
  const { spawnHidden, killTree } = require("../servers/subagents/lib/win-command.js");
  const child = spawnHidden(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform !== "win32" });
  await new Promise((r) => child.once("spawn", r));
  const exited = new Promise((r) => child.once("exit", r));
  await killTree(child);
  await exited;
  assert.ok(child.exitCode != null || child.signalCode != null);
});
