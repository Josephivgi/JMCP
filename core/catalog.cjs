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
      "Lets any agent start subagents from other providers: Claude Code can run Droid, Codex, Devin, Cursor, OpenCode, Grok and more on a task, wait for their replies, or run several as a workflow. Subagents cannot start subagents.",
    tools: ["providers", "spawn", "workflow", "workflow_status", "list", "wait", "send", "read", "stop"],
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
// agents run.
async function copyDir(src, dest) {
  const next = dest + ".new";
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.cp(src, next, { recursive: true, filter: (p) => !/[\\/](test|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.rename(next, dest);
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

// Install into the given agents (default: every agent found on this computer).
async function installServer(id, agentIds, home) {
  const item = catalogItem(id);
  const def = await prepare(item, home);
  const targets = agentIds && agentIds.length ? agentIds : agents.scan(home).filter((a) => a.present).map((a) => a.id);
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
  }));
}

module.exports = { CATALOG, catalogItem, installServer, uninstallServer, catalogState, jmcpHome, nodeCommand };
