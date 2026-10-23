"use strict";

// Config reading and writing on scratch home folders only.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agents = require("../core/agents.cjs");
const catalog = require("../core/catalog.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-test-"));
}

const DEF = { command: "node", args: ["/x/server.cjs"], env: { A: "1" }, passEnv: ["JMCP_SUBAGENT"], toolTimeoutSec: 900 };

test("install, read back and remove in every agent", () => {
  const home = scratch();
  for (const a of agents.AGENTS) agents.install(a.id, "demo", DEF, home);
  const list = agents.scan(home);
  for (const a of list) {
    const s = a.servers.find((x) => x.name === "demo");
    assert.ok(s, a.id + " has demo");
    assert.strictEqual(s.command, "node", a.id);
    assert.deepStrictEqual(s.args, ["/x/server.cjs"], a.id);
    assert.strictEqual(s.enabled, true, a.id);
    assert.deepStrictEqual(a.errors, [], a.id);
  }
  for (const a of agents.AGENTS) assert.strictEqual(agents.uninstall(a.id, "demo", home).removed, true, a.id);
  for (const a of agents.scan(home)) assert.ok(!a.servers.some((x) => x.name === "demo"), a.id);
});

test("JSON edits keep other servers, comments and settings", () => {
  const home = scratch();
  const file = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{\n  // mine\n  "mcpServers": {\n    "keep": { "command": "k" },\n  },\n  "other": 1\n}\n');
  agents.install("cursor", "demo", DEF, home);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\/\/ mine/);
  assert.match(text, /"other": 1/);
  const names = agents.scan(home).find((a) => a.id === "cursor").servers.map((s) => s.name);
  assert.deepStrictEqual(names.sort(), ["demo", "keep"]);
  assert.ok(fs.existsSync(file + ".jmcp-backup"));
});

test("TOML replace touches only that server's tables", () => {
  const home = scratch();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "x"\n\n[mcp_servers.demo]\ncommand = "old"\n\n[mcp_servers.demo.env]\nB = "2"\n\n[mcp_servers.keep]\ncommand = "k"\n\n[profiles.p]\nmodel = "y"\n');
  agents.install("codex", "demo", DEF, home);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes('command = "old"'));
  assert.ok(!text.includes('B = "2"'));
  assert.match(text, /\[mcp_servers\.keep\]\ncommand = "k"/);
  assert.match(text, /\[profiles\.p\]\nmodel = "y"/);
  assert.match(text, /env_vars = \["JMCP_SUBAGENT"\]/);
  assert.match(text, /tool_timeout_sec = 900/);
  const codex = agents.scan(home).find((a) => a.id === "codex");
  assert.deepStrictEqual(codex.servers.map((s) => s.name).sort(), ["demo", "keep"]);
  assert.strictEqual(codex.servers.find((s) => s.name === "demo").env.A, "1");
});

test("a broken config file is reported and not overwritten", () => {
  const home = scratch();
  const file = path.join(home, ".grok", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[[[ not toml");
  assert.throws(() => agents.install("grok", "demo", DEF, home), /did not change it/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "[[[ not toml");
  assert.strictEqual(agents.scan(home).find((a) => a.id === "grok").errors.length, 1);
});

test("installing jmcp-subagents copies the server and registers it", async () => {
  const home = scratch();
  const r = await catalog.installServer("subagents", ["claude-code", "codex", "factory-droid"], home);
  assert.ok(r.results.every((x) => x.ok));
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "subagents", "server.cjs")));
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "subagents", "node_modules", "@anthropic-ai", "claude-agent-sdk")));
  const st = catalog.catalogState(home)[0];
  assert.deepStrictEqual(st.installedIn.sort(), ["claude-code", "codex", "factory-droid"]);
  catalog.uninstallServer("subagents", [], home);
  assert.deepStrictEqual(catalog.catalogState(home)[0].installedIn, []);
});

test("OpenCode 2 nested servers are read and written in place", () => {
  const home = scratch();
  const file = path.join(home, ".config", "opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{\n\t"mcp": {"servers": {"gk": {"type": "local", "command": ["gk", "mcp"],}}},\n\t// keep me\n}\n');
  agents.install("opencode", "demo", DEF, home);
  const oc = agents.scan(home).find((a) => a.id === "opencode");
  assert.deepStrictEqual(oc.servers.map((s) => s.name).sort(), ["demo", "gk"]);
  assert.strictEqual(oc.servers.find((s) => s.name === "gk").command, "gk");
  assert.match(fs.readFileSync(file, "utf8"), /\/\/ keep me/);
  assert.ok(require("jsonc-parser").parse(fs.readFileSync(file, "utf8")).mcp.servers.demo);
  assert.strictEqual(agents.uninstall("opencode", "demo", home).removed, true);
});
