"use strict";

// Connections: JMCP connecting other apps, starting with JAgents Terminal,
// on scratch homes. The plugin is loaded with a stand-in ctx here; the real
// check is loading it in a running JAgents Terminal window.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const connections = require("../core/connections.cjs");

const CLI = path.join(__dirname, "..", "cli", "jmcp.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-conn-"));
const withJAgents = () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, "AppData", "Roaming", "JAgents-Terminal", "plugins"), { recursive: true });
  return home;
};
const plugin = (home) => path.join(home, "AppData", "Roaming", "JAgents-Terminal", "plugins", "jmcp");
const fresh = (dir) => {
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
  return require(path.join(dir, "main.cjs"));
};

test("JAgents Terminal is listed and not connected when it is not installed", () => {
  const home = scratch();
  const [a] = connections.list(home);
  assert.strictEqual(a.id, "jagents-terminal");
  assert.strictEqual(a.present, false);
  assert.strictEqual(a.state, "not-connected");
  assert.deepStrictEqual(connections.sync(home), []);
  assert.throws(() => connections.connect(home, "jagents-terminal"), /not installed/);
  assert.throws(() => connections.connect(home, "nope"), /No app nope/);
});

test("sync connects JAgents Terminal by itself once, and disconnect sticks", () => {
  const home = withJAgents();
  const [r] = connections.sync(home);
  assert.strictEqual(r.action, "connected");
  assert.strictEqual(r.connection.state, "connected");
  assert.strictEqual(r.connection.auto, true);
  for (const f of ["main.cjs", "lib.cjs", "view.cjs", "plugin.json", "connection.json"]) assert.ok(fs.existsSync(path.join(plugin(home), f)), f);
  const mark = JSON.parse(fs.readFileSync(path.join(plugin(home), "connection.json"), "utf8"));
  assert.strictEqual(mark.by, "JMCP");
  assert.strictEqual(mark.jmcpHome, path.join(home, ".jmcp"));
  assert.deepStrictEqual(connections.sync(home), []);

  const off = connections.disconnect(home, "jagents-terminal");
  assert.strictEqual(off.state, "disconnected");
  assert.ok(!fs.existsSync(plugin(home)));
  assert.deepStrictEqual(connections.sync(home), []);
  assert.ok(!fs.existsSync(plugin(home)), "a disconnected app is not connected again");

  const on = connections.connect(home, "jagents-terminal");
  assert.strictEqual(on.state, "connected");
  assert.strictEqual(on.auto, false);
});

test("a plugin removed in JAgents is shown as missing and not put back", () => {
  const home = withJAgents();
  connections.sync(home);
  fs.rmSync(plugin(home), { recursive: true });
  assert.deepStrictEqual(connections.sync(home), []);
  assert.ok(!fs.existsSync(plugin(home)));
  assert.strictEqual(connections.list(home)[0].pluginMissing, true);
});

test("an older plugin is updated, and a plugin JMCP did not make is left alone", () => {
  const home = withJAgents();
  connections.sync(home);
  const pj = path.join(plugin(home), "plugin.json");
  fs.writeFileSync(pj, JSON.stringify({ name: "JMCP", version: "0.0.1" }));
  const [u] = connections.sync(home);
  assert.strictEqual(u.action, "updated");
  assert.strictEqual(u.from, "0.0.1");
  assert.notStrictEqual(JSON.parse(fs.readFileSync(pj, "utf8")).version, "0.0.1");

  const other = withJAgents();
  fs.mkdirSync(plugin(other));
  fs.writeFileSync(path.join(plugin(other), "main.cjs"), "// someone else's");
  const [r] = connections.sync(other);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /did not make/);
  connections.disconnect(other, "jagents-terminal");
  assert.strictEqual(fs.readFileSync(path.join(plugin(other), "main.cjs"), "utf8"), "// someone else's");
});

test("the plugin lists subagents, records a heartbeat and calls a JMCP server", async () => {
  const home = withJAgents();
  connections.sync(home);
  const jhome = path.join(home, ".jmcp");
  // A subagents database like jmcp-subagents writes.
  const db = new DatabaseSync(path.join(jhome, "subagents.db"));
  db.exec("CREATE TABLE subagents (session TEXT, handle TEXT, parent TEXT, provider TEXT, provider_name TEXT, task TEXT, cwd TEXT, status TEXT, error TEXT, model TEXT, effort TEXT, workflow TEXT, created_at INTEGER, updated_at INTEGER, transcript TEXT)");
  db.prepare("INSERT INTO subagents (session, handle, provider_name, task, status, updated_at) VALUES ('s', 'claude-1', 'Claude Code', 'fix the tests', 'busy', ?)").run(Date.now());
  db.close();
  // The installed jmcp-memory, as JMCP copies it.
  fs.cpSync(path.join(__dirname, "..", "servers", "memory"), path.join(jhome, "servers", "memory"), { recursive: true });

  const commands = new Map();
  const tools = new Map();
  const toasts = [];
  const cleanups = [];
  const ctx = {
    notify: (t) => toasts.push(t),
    dispose: (fn) => cleanups.push(fn),
    terminal: { commands: { register: (c) => commands.set(c.id, c) } },
    mcp: { server: (name) => ({ tool: (t) => tools.set(name + "." + t.name, t) }) },
  };
  fresh(plugin(home)).activate(ctx);
  try {
    assert.ok(connections.list(home)[0].lastSeen > 0, "heartbeat recorded");
    assert.deepStrictEqual([...commands.keys()].sort(), ["memories", "providers", "rules", "skills", "status", "subagents", "view"]);
    assert.deepStrictEqual([...tools.keys()].sort(), ["jmcp.call", "jmcp.status", "jmcp.subagents", "jmcp.tools"]);

    const subs = tools.get("jmcp.subagents").handler({});
    assert.strictEqual(subs.subagents[0].handle, "claude-1");
    await commands.get("subagents").handler();
    assert.match(toasts.pop(), /1 working, 1 recent\. claude-1 busy \(Claude Code\)/);

    const st = tools.get("jmcp.status").handler({});
    assert.deepStrictEqual(st.servers.map((s) => s.name), ["jmcp-memory"]);

    // A real stdio call through the bridge, into the scratch home.
    const saved = await tools.get("jmcp.call").handler({ server: "jmcp-memory", tool: "memory_save", arguments: { title: "From JAgents", body: "saved through the connection" } });
    assert.ok(saved);
    assert.ok(require("../core/memory.cjs").list(home).some((m) => m.title === "From JAgents"));
    await commands.get("memories").handler();
    assert.match(toasts.pop(), /JMCP memories: from-jagents/);
    await assert.rejects(tools.get("jmcp.call").handler({ server: "health", tool: "problems" }), /not installed/);
  } finally {
    for (const fn of cleanups) fn();
  }
});

test("the view prints servers and subagents", () => {
  const home = withJAgents();
  connections.sync(home);
  const out = execFileSync(process.execPath, [path.join(plugin(home), "view.cjs"), "--once"], { encoding: "utf8", windowsHide: true });
  assert.match(out, /JMCP {2}connected to JAgents Terminal/);
  assert.match(out, /Subagents \(0 working, 0 recent\)/);
});

test("CLI connections, connect and disconnect", () => {
  const home = withJAgents();
  const run = (...a) => execFileSync(process.execPath, [CLI, ...a, "--home", home], { encoding: "utf8", windowsHide: true });
  assert.match(run("connections"), /JAgents Terminal {2}not connected/);
  assert.match(run("connect", "jagents-terminal"), /JAgents Terminal connected/);
  assert.match(run("connections"), /JAgents Terminal {2}connected/);
  assert.match(run("disconnect", "jagents-terminal"), /JAgents Terminal disconnected/);
  const list = JSON.parse(run("connections", "--json"));
  assert.strictEqual(list[0].state, "disconnected");
});
