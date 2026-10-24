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

test("update replaces an older copy and rewrites the agents that have it", async () => {
  const home = scratch();
  await catalog.installServer("subagents", ["codex", "cursor"], home);
  const pkg = path.join(home, ".jmcp", "servers", "subagents", "package.json");
  const latest = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  // Pretend an older version is installed, and its Codex entry is stale.
  fs.writeFileSync(pkg, JSON.stringify({ version: "0.0.1" }));
  agents.install("codex", "jmcp-subagents", { command: "old-node", args: ["x"] }, home);
  let st = catalog.catalogState(home)[0];
  assert.strictEqual(st.updateAvailable, true);
  assert.strictEqual(st.installed, "0.0.1");
  const r = await catalog.updateAll(home);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].from, "0.0.1");
  assert.strictEqual(r[0].to, latest);
  assert.deepStrictEqual(r[0].results.map((x) => x.agent).sort(), ["codex", "cursor"]);
  st = catalog.catalogState(home)[0];
  assert.strictEqual(st.updateAvailable, false);
  const codex = agents.scan(home).find((a) => a.id === "codex").servers.find((s) => s.name === "jmcp-subagents");
  assert.notStrictEqual(codex.command, "old-node");
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "subagents", "server.cjs")));
  assert.ok(!fs.existsSync(path.join(home, ".jmcp", "servers", "subagents.old")));
  assert.deepStrictEqual(await catalog.updateAll(home), []);
});

test("versions compare by number", () => {
  assert.strictEqual(catalog.compareVersions("0.10.0", "0.9.9"), 1);
  assert.strictEqual(catalog.compareVersions("0.2.0", "0.2.0"), 0);
  assert.strictEqual(catalog.compareVersions("1.0.0", "1.0.1"), -1);
  // SemVer precedence: a release is newer than its prereleases.
  assert.strictEqual(catalog.compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.strictEqual(catalog.compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.strictEqual(catalog.compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.strictEqual(catalog.compareVersions("1.0.0+b1", "1.0.0"), 0);
});

test("TOML removal stops at array tables and finds quoted headers", () => {
  const home = scratch();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "x"\n\n[mcp_servers.demo]\ncommand = "old"\n\n[[skills.config]]\nname = "s"\n\n[ mcp_servers . "demo" .env ]\nB = "2"\n');
  agents.install("codex", "demo", DEF, home);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[\[skills\.config\]\]\nname = "s"/);
  assert.ok(!text.includes('B = "2"'));
  assert.strictEqual((text.match(/\[mcp_servers\.demo\]/g) || []).length, 1);
  require("smol-toml").parse(text);
  assert.strictEqual(agents.uninstall("codex", "demo", home).removed, true);
  assert.match(fs.readFileSync(file, "utf8"), /\[\[skills\.config\]\]/);
});

test("TOML removal keeps bracketed keys and multi-line strings", () => {
  const { removeTomlServer } = agents._toml;
  const a = ['[mcp_servers.demo]', 'command = "a"', '', '[projects."C:/work/repo[1]"]', 'trust_level = "trusted"'].join("\n");
  assert.match(removeTomlServer(a, "demo"), /\[projects\."C:\/work\/repo\[1\]"\]\ntrust_level = "trusted"/);
  const b = ['[mcp_servers.keep]', 'doc = """', '[mcp_servers.demo]', '"""', '', '[mcp_servers.demo]', 'command = "d"'].join("\n");
  const out = removeTomlServer(b, "demo");
  assert.match(out, /doc = """\n\[mcp_servers\.demo\]\n"""/);
  assert.ok(!out.includes('command = "d"'));
  require("smol-toml").parse(out);
  // An escaped \""" inside a """ string does not end it.
  const c = ['[mcp_servers.keep]', 'doc = """', 'one \\"""', '[mcp_servers.demo]', 'two \\"""', '"""', '[mcp_servers.demo]', 'command = "d"'].join("\n");
  const kept = removeTomlServer(c, "demo");
  assert.match(kept, /one \\"""\n\[mcp_servers\.demo\]\ntwo \\"""\n"""/);
  assert.ok(!kept.includes('command = "d"'));
});

test("OpenCode writes the entry the agent reads and drops a shadowed copy", () => {
  const home = scratch();
  const file = path.join(home, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"mcp": {"demo": {"type": "local", "command": ["old"]}, "servers": {"demo": {"type": "local", "command": ["old2"]}}}}\n');
  agents.install("opencode", "demo", DEF, home);
  const j = require("jsonc-parser").parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(j.mcp.demo, undefined);
  assert.deepStrictEqual(j.mcp.servers.demo.command, ["node", "/x/server.cjs"]);
  // A flat server that happens to be named "servers" is not the nested map.
  fs.writeFileSync(file, '{"mcp": {"servers": {"type": "local", "command": ["node", "existing.cjs"]}}}\n');
  agents.install("opencode", "demo", DEF, home);
  const names = agents.scan(home).find((a) => a.id === "opencode").servers.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ["demo", "servers"]);
});

test("a JSON config the parser only half reads is an error and is not rewritten", () => {
  const home = scratch();
  const file = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"mcpServers": {}, "other": 1');
  assert.match(agents.scan(home).find((a) => a.id === "cursor").errors.join(" "), /not valid JSON/);
  assert.throws(() => agents.install("cursor", "demo", DEF, home), /JMCP did not change it/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), '{"mcpServers": {}, "other": 1');
});

test("the CLI refuses --home without a folder and exits 1 when something failed", () => {
  const { spawnSync } = require("node:child_process");
  const CLI = path.join(__dirname, "..", "cli", "jmcp.cjs");
  const noHome = spawnSync(process.execPath, [CLI, "install", "rules", "--home"], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(noHome.status, 2);
  assert.match(noHome.stderr, /--home needs a folder/);
  const home = scratch();
  const file = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ broken");
  const r = spawnSync(process.execPath, [CLI, "install", "rules", "cursor", "--home", home], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
});

test("a config that exists but cannot be read is an error, not empty", () => {
  const home = scratch();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[mcp_servers.demo]\ncommand = "a"\n');
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (String(p) === file ? (() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })() : read(p, ...rest));
  try {
    const codex = agents.scan(home).find((a) => a.id === "codex");
    assert.match(codex.errors.join(" "), /EACCES/);
  } finally {
    fs.readFileSync = read;
  }
});

test("an update while a config cannot be read retries that config later", async () => {
  const home = scratch();
  await catalog.installServer("rules", ["codex"], home);
  fs.writeFileSync(path.join(home, ".jmcp", "servers", "rules", "package.json"), JSON.stringify({ version: "0.0.1" }));
  const file = path.join(home, ".codex", "config.toml");
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (String(p) === file ? (() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })() : read(p, ...rest));
  let r;
  try {
    r = await catalog.updateAll(home);
  } finally {
    fs.readFileSync = read;
  }
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].error, /codex/);
  r = await catalog.updateAll(home);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ok, true);
  assert.deepStrictEqual(r[0].results.map((x) => x.agent), ["codex"]);
});

test("OpenCode uninstall removes the server from whichever file has it", () => {
  const home = scratch();
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode.json"), '{"mcp": {}}\n');
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), '{"mcp": {"demo": {"type": "local", "command": ["x"]}}}\n');
  assert.ok(agents.scan(home).find((a) => a.id === "opencode").servers.some((x) => x.name === "demo"));
  assert.strictEqual(agents.uninstall("opencode", "demo", home).removed, true);
  assert.ok(!agents.scan(home).find((a) => a.id === "opencode").servers.some((x) => x.name === "demo"));
  // Both layouts in one file.
  fs.writeFileSync(path.join(dir, "opencode.json"), '{"mcp": {"demo": {"type": "local", "command": ["x"]}, "servers": {"demo": {"type": "local", "command": ["y"]}}}}\n');
  assert.strictEqual(agents.uninstall("opencode", "demo", home).removed, true);
  const left = require("jsonc-parser").parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"));
  assert.ok(!left.mcp.demo && !left.mcp.servers.demo);
});

test("an agent config that failed to update is retried on the next update", async () => {
  const home = scratch();
  await catalog.installServer("rules", ["codex"], home);
  const file = path.join(home, ".codex", "config.toml");
  const pkg = path.join(home, ".jmcp", "servers", "rules", "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ version: "0.0.1" }));
  // A config file that cannot be written right now.
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  const busy = (p) => String(p).startsWith(path.dirname(file));
  fs.writeFileSync = (p, ...rest) => (busy(p) ? (() => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); })() : write(p, ...rest));
  fs.renameSync = (a, b) => (busy(b) ? (() => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); })() : rename(a, b));
  let r;
  try {
    r = await catalog.updateAll(home);
  } finally {
    fs.writeFileSync = write;
    fs.renameSync = rename;
  }
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].error, /codex/);
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "rules.retry.json")));
  // While the config cannot be read, it stays waiting.
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, good + '\nbroken = """\n');
  r = await catalog.updateAll(home);
  assert.strictEqual(r[0].ok, false);
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "servers", "rules.retry.json")));
  fs.writeFileSync(file, good);
  r = await catalog.updateAll(home);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ok, true);
  assert.ok(!fs.existsSync(path.join(home, ".jmcp", "servers", "rules.retry.json")));
  assert.deepStrictEqual(await catalog.updateAll(home), []);
});

test("installing where it already is needs force", async () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  await catalog.installServer("subagents", ["codex"], home);
  const file = path.join(home, ".codex", "config.toml");
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(catalog.installServer("subagents", ["codex", "cursor"], home), (e) => /already in Codex/.test(e.message) && e.already.join() === "codex");
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
  assert.ok(!agents.scan(home).find((a) => a.id === "cursor").servers.length, "nothing installed when refused");
  const r = await catalog.installServer("subagents", ["codex", "cursor"], home, { force: true });
  assert.ok(r.results.every((x) => x.ok));
});
