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
  assert.deepStrictEqual(tools.map((t) => t.name), ["providers", "models", "spawn", "list", "wait", "send", "read", "stop"]);
  await c.close();
});

test("models answers from the kept lists without starting an agent", async () => {
  const dir = home();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "subagents.db"));
  db.exec("CREATE TABLE models (provider TEXT PRIMARY KEY, models TEXT, current TEXT, efforts TEXT, error TEXT, checked_at INTEGER)");
  const kept = [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }];
  db.prepare("INSERT INTO models VALUES (?,?,?,?,?,?)").run("claude-code", JSON.stringify(kept), "opus", JSON.stringify(["low", "high"]), "", Date.now());
  db.close();
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: dir, JMCP_SUBAGENT: "" } });
  await c.initialize("test");
  // Fresh lists are not read again, so nothing starts.
  const r = JSON.parse((await c.callTool("models", { provider: "claude" })).text);
  assert.strictEqual(r.providers.length, 1);
  const p = r.providers[0];
  assert.strictEqual(p.provider, "claude-code");
  assert.deepStrictEqual(p.models, kept);
  assert.strictEqual(p.current, "opus");
  assert.deepStrictEqual(p.efforts, ["low", "high"]);
  assert.strictEqual(p.refreshing, undefined);
  assert.match((await c.callTool("models", { provider: "nope" })).text, /Unknown provider/);
  assert.match((await c.callTool("models", { refresh: "yes" })).text, /Invalid arguments/);
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

// ---- What results cost the parent's context ----

const sub = (rows, extra) =>
  Object.assign({ handle: "claude-1", provider: "claude-code", providerName: "Claude Code", task: "T".repeat(5000), cwd: "C:/x", status: "ready", error: "", queue: [], using: {}, want: {}, rows }, extra);

test("a finished wait returns the whole reply once, as plain text after the JSON", () => {
  const { turnResult, result } = require(SERVER);
  const reply = 'Line one\nLine "two"\n' + "x".repeat(3000);
  const r = turnResult(sub([{ role: "user", text: "go" }, { role: "assistant", text: reply }]), "done");
  assert.strictEqual(r.reply, reply);
  assert.strictEqual(r.task, undefined);
  const text = result(r).content[0].text;
  // No escaped newlines or quotes, no indentation.
  assert.ok(text.endsWith("\n\nReply:\n" + reply));
  assert.doesNotMatch(text, /\n {2}"/);
});

test("a wait that times out returns progress, not the reply so far", () => {
  const { turnResult, result } = require(SERVER);
  const long = "y".repeat(15000) + "END";
  const s = sub([{ role: "user", text: "go" }, { role: "assistant", text: long }, { role: "tool", text: "Read   C:/big/file.txt", status: "in_progress" }], { status: "busy" });
  const r = turnResult(s, "timeout");
  assert.strictEqual(r.reply, undefined);
  assert.ok(r.saying.length <= 303 && r.saying.endsWith("END"));
  assert.strictEqual(r.lastTool, "Read C:/big/file.txt");
  assert.match(r.hint, /Call wait/);
  assert.ok(result(r).content[0].text.length < 600);
});

test("read keeps the newest rows that fit, hides thinking and shortens tool rows", () => {
  const { transcript } = require(SERVER);
  const rows = [{ role: "user", text: "first task" }];
  for (let i = 0; i < 40; i++) {
    rows.push({ role: "thought", text: "thinking " + i + " " + "t".repeat(3000) });
    rows.push({ role: "tool", text: "Bash " + "c".repeat(400), status: "completed" });
    rows.push({ role: "assistant", text: "step " + i + " " + "a".repeat(1000) });
  }
  const s = sub(rows);
  const out = transcript(s, { limit: 400 });
  assert.ok(out.length <= 12000 + 400, String(out.length));
  assert.doesNotMatch(out, /\] thinking \d/);
  assert.match(out, /thinking rows hidden/);
  assert.match(out, /earlier rows left out/);
  assert.match(out, /step 39 a+$/);
  assert.ok(out.split("\n").filter((l) => l.startsWith("[tool]")).every((l) => l.length <= 7 + 163));
  const withThoughts = transcript(s, { limit: 3, thoughts: true, max_chars: 100000 });
  assert.match(withThoughts, /\[thought\] thinking 39/);
  // Small transcripts come back whole.
  const small = transcript(sub([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]), {});
  assert.strictEqual(small, "claude-1 (claude-code): ready\n\n[you] hi\n[claude-1] hello");
});

test("list shows the start of each task; stopped ones carry no reply", () => {
  const { view } = require(SERVER);
  const rows = [{ role: "user", text: "go" }, { role: "assistant", text: "r".repeat(2000) }];
  const live = view(sub(rows), 300, 160);
  assert.strictEqual(live.task.length, 160);
  assert.strictEqual(live.reply.length, 300);
  const stopped = view(sub(rows, { status: "stopped" }), 0, 160);
  assert.strictEqual(stopped.reply, undefined);
});

test("the MCP client reads a reply sent after the JSON", async () => {
  const { connect } = require("../core/mcp-client.cjs");
  const script = path.join(home(), "fake.cjs");
  // A tiny stdio server that answers every tools/call with the reply format.
  const fake = () => {
    process.stdin.on("data", (d) => {
      for (const line of String(d).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id == null) continue;
        const result = m.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify({ handle: "a-1", status: "ready" }) + "\n\nReply:\nhi\nthere" }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x" } };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
      }
    });
  };
  fs.writeFileSync(script, "(" + fake.toString() + ")();");
  const c = connect(process.execPath, [script]);
  await c.initialize("test");
  const r = await c.callTool("wait", { agent: "a-1" });
  assert.deepStrictEqual(r.json, { handle: "a-1", status: "ready", reply: "hi\nthere" });
  await c.close();
});

test("models leaves out descriptions unless details is true", async () => {
  const dir = home();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "subagents.db"));
  db.exec("CREATE TABLE models (provider TEXT PRIMARY KEY, models TEXT, current TEXT, efforts TEXT, error TEXT, checked_at INTEGER)");
  const kept = [{ id: "opus", name: "Opus", description: "Most capable" }, { id: "sonnet", name: "sonnet" }];
  db.prepare("INSERT INTO models VALUES (?,?,?,?,?,?)").run("claude-code", JSON.stringify(kept), "opus", "[]", "", Date.now());
  db.close();
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: dir, JMCP_SUBAGENT: "" } });
  await c.initialize("test");
  const short = JSON.parse((await c.callTool("models", { provider: "claude" })).text);
  assert.deepStrictEqual(short.providers[0].models, [{ id: "opus", name: "Opus" }, { id: "sonnet" }]);
  const full = JSON.parse((await c.callTool("models", { provider: "claude", details: true })).text);
  assert.deepStrictEqual(full.providers[0].models, kept);
  await c.close();
});

test("terminal output keeps at most the asked or default tail", async () => {
  const { AcpClient } = require("../servers/subagents/lib/acp-client.js");
  const c = new AcpClient({ cwd: os.tmpdir() });
  const big = c._createTerminal({ command: process.execPath, args: ["-e", "process.stdout.write('z'.repeat(200000) + 'TAIL')"] }).terminalId;
  await c._waitTerminal({ terminalId: big });
  const out = c._terminalOutput({ terminalId: big });
  assert.strictEqual(out.output.length, 64 * 1024);
  assert.ok(out.output.endsWith("TAIL") && out.truncated);
  const small = c._createTerminal({ command: process.execPath, args: ["-e", "process.stdout.write('q'.repeat(5000) + 'END')"], outputByteLimit: 1000 }).terminalId;
  await c._waitTerminal({ terminalId: small });
  const o2 = c._terminalOutput({ terminalId: small });
  assert.strictEqual(o2.output.length, 1000);
  assert.ok(o2.output.endsWith("END") && o2.truncated);
  await c.stop();
});
