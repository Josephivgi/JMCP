"use strict";

// The shared rules database and its read-only MCP server, on scratch homes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const rules = require("../core/rules.cjs");
const catalog = require("../core/catalog.cjs");
const agents = require("../core/agents.cjs");
const { connect } = require("../core/mcp-client.cjs");

const SERVER = path.join(__dirname, "..", "servers", "rules", "server.cjs");
const CLI = path.join(__dirname, "..", "cli", "jmcp.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-rules-"));

test("rules CRUD, validation and ordering", () => {
  const home = scratch();
  assert.deepStrictEqual(rules.list(home), []);
  assert.strictEqual(rules.instructions([]), "");
  assert.throws(() => rules.add(home, { kind: "maybe", text: "x" }), /kind must be/);
  assert.throws(() => rules.add(home, { kind: "do", text: "  " }), /text must not be empty/);
  const first = rules.add(home, { kind: "do", text: "  Check tests  " });
  const second = rules.add(home, { kind: "dont", text: "Overwrite work", agents: ["codex"] });
  assert.strictEqual(second.agents, undefined);
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "rules.db")));
  assert.match(first.id, /^[\da-f-]{36}$/);
  assert.strictEqual(first.text, "Check tests");
  assert.strictEqual(first.enabled, true);
  assert.strictEqual(first.position, 0);
  assert.strictEqual(second.position, 1);
  assert.deepStrictEqual(rules.list(home).map((r) => r.id), [first.id, second.id]);
  assert.throws(() => rules.update(home, first.id, { kind: "no" }), /kind must be/);
  assert.throws(() => rules.update(home, first.id, { text: "" }), /text must not be empty/);
  assert.throws(() => rules.update(home, first.id, { enabled: 0 }), /enabled must be/);
  assert.throws(() => rules.update(home, first.id, { position: 1.2 }), /position must be/);
  const changed = rules.update(home, second.id, { kind: "do", text: "  Use scratch  ", position: -1, enabled: false });
  assert.strictEqual(changed.kind, "do");
  assert.strictEqual(changed.text, "Use scratch");
  assert.strictEqual(changed.enabled, false);
  assert.strictEqual(changed.position, -1);
  assert.deepStrictEqual(rules.list(home).map((r) => r.id), [second.id, first.id]);
  assert.deepStrictEqual(rules.active(home).map((r) => r.id), [first.id]);
  assert.strictEqual(rules.update(home, "missing", { text: "x" }), null);
  assert.strictEqual(rules.remove(home, second.id), true);
  assert.strictEqual(rules.remove(home, second.id), false);
  assert.deepStrictEqual(rules.list(home).map((r) => r.id), [first.id]);
});

test("every enabled rule applies to every agent, with instruction text", () => {
  const home = scratch();
  const first = rules.add(home, { kind: "do", text: "Run tests" });
  // Old per-agent lists are ignored.
  const scoped = rules.add(home, { kind: "dont", text: "Commit work", agents: ["codex"] });
  const third = rules.add(home, { kind: "do", text: "Keep changes small" });
  const hidden = rules.add(home, { kind: "dont", text: "Skip review" });
  rules.update(home, hidden.id, { enabled: false });
  assert.deepStrictEqual(rules.active(home).map((r) => r.id), [first.id, scoped.id, third.id]);
  assert.strictEqual(rules.instructions(rules.active(home)), "Do:\n- Run tests\n- Keep changes small\n\nDon't:\n- Commit work");
  assert.strictEqual(rules.instructions([{ kind: "dont", text: "Open windows" }]), "Don't:\n- Open windows");
  assert.ok(!rules.instructions(rules.active(home)).includes("Skip review"));
  rules.update(home, scoped.id, { position: -1 });
  assert.deepStrictEqual(rules.active(home).map((r) => r.id), [scoped.id, first.id, third.id]);
});

test("catalog installs and updates the same rules server in every agent", async () => {
  const home = scratch();
  const item = catalog.catalogItem("rules");
  assert.strictEqual(item.name, "jmcp-rules");
  assert.deepStrictEqual(item.tools, ["rules"]);
  const installed = await catalog.installServer("rules", ["claude-code", "codex", "factory-droid"], home);
  assert.ok(installed.results.every((r) => r.ok));
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "rules", "lib", "store.js")));
  for (const id of ["claude-code", "codex", "factory-droid"]) {
    const server = agents.scan(home).find((a) => a.id === id).servers.find((s) => s.name === "jmcp-rules");
    assert.deepStrictEqual(server.args, [path.join(home, ".jmcp", "servers", "rules", "server.cjs")]);
  }
  agents.install("codex", "jmcp-rules", { command: "old-node", args: [SERVER] }, home);
  const updated = await catalog.updateServer("rules", home);
  assert.ok(updated.results.every((r) => r.ok));
  assert.deepStrictEqual(agents.scan(home).find((a) => a.id === "codex").servers.find((s) => s.name === "jmcp-rules").args, [path.join(home, ".jmcp", "servers", "rules", "server.cjs")]);
  await catalog.installServer("subagents", ["cursor"], home);
  const sub = agents.scan(home).find((a) => a.id === "cursor").servers.find((s) => s.name === "jmcp-subagents");
  assert.deepStrictEqual(sub.args, [path.join(home, ".jmcp", "servers", "subagents", "server.cjs")]);
});

test("CLI rules list reads scratch home and offers no editing", () => {
  const home = scratch();
  rules.add(home, { kind: "do", text: "Run tests" });
  const cli = (...args) => execFileSync(process.execPath, [CLI, "rules", ...args, "--home", home], { encoding: "utf8", windowsHide: true });
  assert.match(cli("list"), /^DO  Run tests$/m);
  assert.deepStrictEqual(JSON.parse(cli("list", "--json")).map((r) => r.text), ["Run tests"]);
  assert.match(cli("add"), /Usage: jmcp/);
  assert.strictEqual(rules.list(home).length, 1);
});

test("stdio server returns all rules on initialize and reads changes on each call", async () => {
  const home = scratch();
  const dataDir = path.join(home, ".jmcp");
  rules.add(home, { kind: "do", text: "Use tests" });
  rules.add(home, { kind: "dont", text: "Commit" });
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: dataDir } });
  try {
    const init = await c.initialize("test");
    assert.strictEqual(init.serverInfo.name, "jmcp-rules");
    assert.match(init.instructions, /user's rules, set in JMCP, and must be followed/);
    assert.match(init.instructions, /- Use tests/);
    assert.match(init.instructions, /- Commit/);
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["rules"]);
    assert.deepStrictEqual(tools[0].inputSchema.required, undefined);
    assert.match(tools[0].description, /start of every task/);
    const before = await c.callTool("rules");
    assert.strictEqual(before.isError, false);
    assert.match(before.text, /- Commit/);
    const added = rules.add(home, { kind: "do", text: "Check new rules" });
    const after = await c.callTool("rules");
    assert.match(after.text, /- Check new rules/);
    rules.update(home, added.id, { enabled: false });
    assert.ok(!(await c.callTool("rules")).text.includes("Check new rules"));
    await assert.rejects(c.callTool("nope"), /Unknown tool nope/);
  } finally {
    await c.close();
  }
});

test("rules are short, and the text agents get is bounded", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-rules-cap-"));
  assert.throws(() => rules.add(home, { kind: "do", text: "x".repeat(2001) }), /at most 2000/);
  for (let i = 0; i < 30; i++) rules.add(home, { kind: "do", text: "rule " + i + " " + "y".repeat(1900) });
  const text = rules.instructions(rules.active(home));
  assert.ok(text.length < 41000, "length " + text.length);
  assert.match(text, /were cut at 40000/);
});
