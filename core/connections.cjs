"use strict";

// Connections: other apps JMCP works with. Connecting an app gives it JMCP's
// features (subagents, memory, rules, skills, the other JMCP servers) inside
// that app. JAgents Terminal is the first one: connecting it writes a JMCP
// plugin into its plugins folder, which the running window loads live.
// JAgents Terminal connects by itself the first time JMCP sees it; once you
// disconnect it, it stays disconnected until you connect it again.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { jmcpHome } = require("./catalog.cjs");

function roaming(home) {
  if (home) return path.join(home, "AppData", "Roaming");
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

const APPS = [
  {
    id: "jagents-terminal",
    name: "JAgents Terminal",
    description: "Adds JMCP to the JAgents Terminal Plugins menu and gives agents in its panes a jmcp MCP server.",
    can: ["List subagents and their status", "Open a JMCP view in a new tab", "List subagent providers, rules, skills and memories", "Call any installed JMCP server tool from the jmcp MCP server"],
    auto: true,
    dataDir: (home) => path.join(roaming(home), "JAgents-Terminal"),
    pluginId: "jmcp",
    source: path.join(__dirname, "apps", "jagents-terminal"),
    files: ["lib.cjs", "view.cjs", "main.cjs", "plugin.json"],
  },
];

function appById(id) {
  const a = APPS.find((x) => x.id === id);
  if (!a) throw new Error("No app " + id + ". Apps JMCP can connect: " + APPS.map((x) => x.id).join(", ") + ".");
  return a;
}

function withDb(home, fn) {
  const dir = jmcpHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "connections.db"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
        "CREATE TABLE IF NOT EXISTS connections (app TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('connected', 'disconnected')), auto INTEGER NOT NULL, changed_at INTEGER NOT NULL, last_seen INTEGER, client_version TEXT);",
    );
    return fn(db);
  } finally {
    db.close();
  }
}

function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function pluginDir(app, home) {
  return path.join(app.dataDir(home), "plugins", app.pluginId);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sourceVersion(app) {
  return String((readJson(path.join(app.source, "plugin.json")) || {}).version || "");
}

// The plugin in the app, if JMCP wrote it (connection.json marks it).
function installed(app, home) {
  const dir = pluginDir(app, home);
  if (!fs.existsSync(dir)) return { exists: false, ours: false, version: "" };
  const mark = readJson(path.join(dir, "connection.json"));
  return { exists: true, ours: Boolean(mark && mark.by === "JMCP"), version: String((readJson(path.join(dir, "plugin.json")) || {}).version || "") };
}

// Files are written in place, not renamed in: the app watches the folder and
// Windows will not rename a folder that is being watched. plugin.json goes
// last, after the code it loads.
function writePlugin(app, home) {
  const dir = pluginDir(app, home);
  const now = installed(app, home);
  if (now.exists && !now.ours) throw new Error(app.name + " already has a plugin called " + app.pluginId + " that JMCP did not make. Rename or remove it in " + app.name + " first.");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "connection.json"), JSON.stringify({ by: "JMCP", app: app.id, jmcpHome: jmcpHome(home) }, null, 2) + "\n");
  for (const f of app.files) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(app.source, f)));
}

function row(db, id) {
  return db.prepare("SELECT * FROM connections WHERE app = ?").get(id) || null;
}

function view(app, r, home) {
  const present = fs.existsSync(app.dataDir(home));
  const p = installed(app, home);
  const latest = sourceVersion(app);
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    can: app.can,
    present,
    state: r ? r.state : "not-connected",
    auto: Boolean(r && r.auto),
    connectedAt: r && r.state === "connected" ? r.changed_at : null,
    lastSeen: r ? r.last_seen || null : null,
    pluginDir: pluginDir(app, home),
    pluginVersion: p.ours ? p.version : "",
    latestVersion: latest,
    pluginMissing: Boolean(r && r.state === "connected" && !p.ours),
  };
}

function list(home) {
  return withDb(home, (db) => APPS.map((a) => view(a, row(db, a.id), home)));
}

function connect(home, id, opts) {
  const app = appById(id);
  if (!fs.existsSync(app.dataDir(home))) throw new Error(app.name + " is not installed on this computer (no " + app.dataDir(home) + ").");
  writePlugin(app, home);
  const auto = Boolean(opts && opts.auto);
  return withDb(home, (db) =>
    tx(db, () => {
      db.prepare(
        "INSERT INTO connections (app, state, auto, changed_at) VALUES (?, 'connected', ?, ?) ON CONFLICT(app) DO UPDATE SET state = 'connected', auto = excluded.auto, changed_at = excluded.changed_at",
      ).run(app.id, auto ? 1 : 0, Date.now());
      return view(app, row(db, app.id), home);
    }),
  );
}

// Removes only the plugin JMCP wrote; a plugin someone else made stays.
function disconnect(home, id) {
  const app = appById(id);
  const p = installed(app, home);
  if (p.ours) fs.rmSync(pluginDir(app, home), { recursive: true, force: true });
  return withDb(home, (db) =>
    tx(db, () => {
      db.prepare(
        "INSERT INTO connections (app, state, auto, changed_at) VALUES (?, 'disconnected', 0, ?) ON CONFLICT(app) DO UPDATE SET state = 'disconnected', changed_at = excluded.changed_at",
      ).run(app.id, Date.now());
      return view(app, row(db, app.id), home);
    }),
  );
}

// Run when JMCP starts: connect apps that connect by themselves and were
// never connected or disconnected, and bring older plugins up to date. A
// connected plugin that was removed in the app is left removed and shown
// as missing, so JMCP never puts back something you deleted there.
function sync(home) {
  const out = [];
  for (const app of APPS) {
    try {
      const r = withDb(home, (db) => row(db, app.id));
      if (!fs.existsSync(app.dataDir(home))) continue;
      if (!r && app.auto) {
        out.push({ ok: true, app: app.id, action: "connected", connection: connect(home, app.id, { auto: true }) });
        continue;
      }
      if (r && r.state === "connected") {
        const p = installed(app, home);
        if (p.ours && p.version !== sourceVersion(app)) {
          writePlugin(app, home);
          out.push({ ok: true, app: app.id, action: "updated", from: p.version, to: sourceVersion(app) });
        }
      }
    } catch (e) {
      out.push({ ok: false, app: app.id, error: String(e.message || e) });
    }
  }
  return out;
}

module.exports = { APPS, appById, list, connect, disconnect, sync, pluginDir };
