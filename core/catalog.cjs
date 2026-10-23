"use strict";

// JMCP's own MCP servers, and installing them into every agent at once.
// A server is copied to ~/.jmcp/servers/<id> first, so agents keep working if
// the JMCP app moves or updates, then each agent's config gets an entry that
// runs it with the system Node.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agents = require("./agents.cjs");

const ROOT = path.join(__dirname, "..");

const CATALOG = [
  {
    id: "subagents",
    name: "jmcp-subagents",
    title: "Subagents",
    official: true,
    description:
      "Lets any agent start subagents from other providers: Claude Code can run Droid, Codex, Devin, Cursor, OpenCode, Grok and more on a task and wait for their replies. Subagents cannot start subagents.",
    tools: ["providers", "spawn", "list", "wait", "send", "read", "stop"],
    source: path.join(ROOT, "servers", "subagents"),
    entry: "server.cjs",
    // Codex only forwards listed env vars to MCP servers.
    passEnv: ["JMCP_SUBAGENT", "JMCP_SUBAGENT_PARENT"],
    toolTimeoutSec: 1800,
  },
];

function jmcpHome(home) {
  return path.join(home || os.homedir(), ".jmcp");
}

function nodeCommand() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  // In Electron, process.execPath is the app, not Node.
  if (!process.versions.electron) return { command: process.execPath, env: {} };
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const f = path.join(dir, exe);
    try {
      if (fs.statSync(f).isFile()) return { command: f, env: {} };
    } catch {
      /* next */
    }
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// Copy beside the old copy, then swap, so a half-done copy is never what
// agents run. The old copy is moved aside first; if Windows will not let go
// of it, the new copy is dropped and the old one stays as it was.
async function copyDir(src, dest) {
  const next = dest + ".new";
  const old = dest + ".old";
  restoreOld(dest);
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
  await fs.promises.cp(src, next, { recursive: true, filter: (p) => !/[\\/](test|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  if (fs.existsSync(dest)) {
    try {
      await fs.promises.rename(dest, old);
    } catch (e) {
      await fs.promises.rm(next, { recursive: true, force: true }).catch(() => {});
      throw new Error("Could not replace " + dest + " (" + e.code + "). Close the agents using it and try again.");
    }
  }
  await fs.promises.rename(next, dest);
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
}

// JMCP quit between moving the old copy aside and moving the new one in:
// put the old one back so agents keep a working server.
function restoreOld(dest) {
  try {
    if (!fs.existsSync(dest) && fs.existsSync(dest + ".old")) fs.renameSync(dest + ".old", dest);
  } catch {
    /* next copy tries again */
  }
}

function readVersion(dir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

// 1 when a is newer than b, -1 when older, 0 when the same.
function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function versions(item, home) {
  restoreOld(path.join(jmcpHome(home), "servers", item.id));
  const latest = readVersion(item.source);
  const installed = readVersion(path.join(jmcpHome(home), "servers", item.id));
  return { latest, installed, updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0) };
}

function serverPath(item, home) {
  return path.join(jmcpHome(home), "servers", item.id, item.entry);
}

// Copy the server into ~/.jmcp and return the definition agents get.
async function prepare(item, home) {
  const dest = path.join(jmcpHome(home), "servers", item.id);
  await copyDir(item.source, dest);
  const node = nodeCommand();
  return { command: node.command, args: [path.join(dest, item.entry)], env: node.env, passEnv: item.passEnv, toolTimeoutSec: item.toolTimeoutSec };
}

function catalogItem(id) {
  const item = CATALOG.find((c) => c.id === id || c.name === id);
  if (!item) throw new Error("No JMCP server " + id + ".");
  return item;
}

// Agents among ids that already have this server.
function alreadyIn(item, ids, home) {
  const list = agents.scan(home);
  return ids.filter((id) => (list.find((a) => a.id === id) || { servers: [] }).servers.some((s) => s.name === item.name));
}

// Install into the given agents (default: every agent found on this computer).
// An agent that already has it is only written again with opts.force; without
// it nothing is installed and the error names those agents (err.already).
async function installServer(id, agentIds, home, opts) {
  const item = catalogItem(id);
  const targets = agentIds && agentIds.length ? agentIds : agents.scan(home).filter((a) => a.present).map((a) => a.id);
  const already = alreadyIn(item, targets, home);
  if (already.length && !(opts && opts.force)) {
    const names = already.map((a) => (agents.agentById(a) || { name: a }).name);
    const err = new Error(item.name + " is already in " + names.join(", ") + ". Installing again replaces its entry there.");
    err.already = already;
    throw err;
  }
  const def = await prepare(item, home);
  const results = [];
  for (const a of targets) {
    try {
      results.push(Object.assign({ ok: true }, agents.install(a, item.name, def, home)));
    } catch (e) {
      results.push({ ok: false, agent: a, error: String(e.message || e) });
    }
  }
  return { server: item.name, command: def.command, args: def.args, results };
}

// Replace the copy in ~/.jmcp with this JMCP's version and rewrite the entry
// in every agent that has it (the Node path may have moved). Agents load the
// new copy the next time they start the server.
async function updateServer(id, home) {
  const item = catalogItem(id);
  const before = versions(item, home);
  if (!before.installed) throw new Error(item.name + " is not installed yet.");
  const def = await prepare(item, home);
  const results = [];
  for (const a of agents.scan(home).filter((x) => x.servers.some((s) => s.name === item.name))) {
    try {
      results.push(Object.assign({ ok: true }, agents.install(a.id, item.name, def, home)));
    } catch (e) {
      results.push({ ok: false, agent: a.id, error: String(e.message || e) });
    }
  }
  return { server: item.name, from: before.installed, to: versions(item, home).installed, results };
}

// Every installed JMCP server older than this JMCP, updated. The app runs
// this when it starts.
async function updateAll(home) {
  const out = [];
  for (const item of CATALOG) {
    if (!versions(item, home).updateAvailable) continue;
    try {
      out.push(Object.assign({ ok: true }, await updateServer(item.id, home)));
    } catch (e) {
      out.push({ ok: false, server: item.name, error: String(e.message || e) });
    }
  }
  return out;
}

function uninstallServer(id, agentIds, home) {
  const item = catalogItem(id);
  const targets = agentIds && agentIds.length ? agentIds : agents.AGENTS.map((a) => a.id);
  const results = [];
  for (const a of targets) {
    try {
      results.push(Object.assign({ ok: true }, agents.uninstall(a, item.name, home)));
    } catch (e) {
      results.push({ ok: false, agent: a, error: String(e.message || e) });
    }
  }
  return { server: item.name, results };
}

// Catalog rows with where each server is installed.
function catalogState(home, scanned) {
  const list = scanned || agents.scan(home);
  return CATALOG.map((c) => ({
    id: c.id, name: c.name, title: c.title, official: c.official, description: c.description, tools: c.tools,
    installedIn: list.filter((a) => a.servers.some((s) => s.name === c.name)).map((a) => a.id),
    copied: fs.existsSync(serverPath(c, home)),
    ...versions(c, home),
  }));
}

module.exports = { CATALOG, catalogItem, alreadyIn, installServer, updateServer, updateAll, uninstallServer, catalogState, compareVersions, jmcpHome, nodeCommand };
