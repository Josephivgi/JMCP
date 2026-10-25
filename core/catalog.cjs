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
  {
    id: "rules",
    name: "jmcp-rules",
    title: "Rules",
    official: true,
    description: "Rules set in the JMCP app reach every agent where jmcp-rules is installed.",
    tools: ["rules"],
    source: path.join(ROOT, "servers", "rules"),
    entry: "server.cjs",
  },
  {
    id: "instructions",
    name: "jmcp-instructions",
    title: "Instructions",
    official: true,
    description: "Lets agents list, read, write and delete AGENTS.md, CLAUDE.md, GEMINI.md and QWEN.md files. Deleted and replaced files can be restored on the Instructions page.",
    tools: ["list", "read", "write", "delete"],
    source: path.join(ROOT, "servers", "instructions"),
    entry: "server.cjs",
  },
  {
    id: "memory",
    name: "jmcp-memory",
    title: "Memory",
    official: true,
    description: "Memory shared by every agent: what one agent saves (your preferences, past decisions, project facts), the others can search and read. Manage it on the Memory page.",
    tools: ["memory_search", "memory_read", "memory_save", "memory_delete"],
    source: path.join(ROOT, "servers", "memory"),
    entry: "server.cjs",
  },
  {
    id: "skills",
    name: "jmcp-skills",
    title: "Skills",
    official: true,
    description: "Your skills library for every agent, even ones with no skills feature. Agents see each skill's description and load the full instructions when a task matches. Manage it on the Skills page.",
    tools: ["skills_list", "skill_read"],
    source: path.join(ROOT, "servers", "skills"),
    entry: "server.cjs",
  },
  {
    id: "health",
    name: "jmcp-health",
    title: "Health",
    official: true,
    description: "Checks this computer or any SSH host, read-only, and explains what is wrong: problems found, why text is slow to show in the browser, and why the computer feels glitchy. Agents can also leave you cards on the Health page.",
    tools: ["targets", "problems", "slow_text", "glitchy", "show_user"],
    source: path.join(ROOT, "servers", "health"),
    entry: "server.cjs",
    toolTimeoutSec: 180,
  },
  {
    id: "browser",
    name: "jmcp-browser",
    title: "Browser",
    official: true,
    description: "Gives every agent a hidden, headless browser (Chrome or Edge) to open pages, read them, click, type and take screenshots. Watch the browsers your agents have open on the Browsers page.",
    tools: ["browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_back", "browser_screenshot", "browser_eval", "browser_handoff", "browser_list", "browser_close"],
    source: path.join(ROOT, "servers", "browser"),
    entry: "server.cjs",
    // browser_handoff waits up to 15 minutes for the user.
    toolTimeoutSec: 960,
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
  try {
    await fs.promises.rename(next, dest);
  } catch (e) {
    // Put the old copy back right away; agents must not be left with no
    // server until the next JMCP run.
    if (!fs.existsSync(dest) && fs.existsSync(old)) await fs.promises.rename(old, dest).catch(() => {});
    await fs.promises.rm(next, { recursive: true, force: true }).catch(() => {});
    throw new Error("Could not replace " + dest + " (" + e.code + "). Close the agents using it and try again.");
  }
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

// 1 when a is newer than b, -1 when older, 0 when the same, by SemVer
// precedence: 1.0.0 is newer than 1.0.0-rc.1, build metadata is ignored.
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).trim().replace(/^v/, "").split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) > (y.core[i] || 0) ? 1 : -1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
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
  const found = agents.scan(home);
  for (const a of found.filter((x) => x.servers.some((s) => s.name === item.name))) {
    try {
      results.push(Object.assign({ ok: true }, agents.install(a.id, item.name, def, home)));
    } catch (e) {
      results.push({ ok: false, agent: a.id, error: String(e.message || e) });
    }
  }
  // An agent whose config could not be written is retried on the next
  // update, even though the copy is already current. One still waiting
  // whose config cannot be read right now stays waiting; one whose config
  // reads fine without the server had it removed, so it is dropped.
  const retry = retryFile(item, home);
  for (const id of readRetry(retry)) {
    if (results.some((r) => r.agent === id)) continue;
    const a = found.find((x) => x.id === id);
    if (a && a.errors && a.errors.length) results.push({ ok: false, agent: id, error: a.errors[0] });
  }
  // A config that cannot be read now may hold the server too: retry it.
  for (const a of found) {
    if (a.errors && a.errors.length && !results.some((r) => r.agent === a.id)) results.push({ ok: false, agent: a.id, error: a.errors[0] });
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) fs.writeFileSync(retry, JSON.stringify(failed.map((r) => r.agent)));
  else fs.rmSync(retry, { force: true });
  const out = { ok: !failed.length, server: item.name, from: before.installed, to: versions(item, home).installed, results };
  if (failed.length) out.error = "Could not update " + failed.map((r) => r.agent + " (" + r.error + ")").join(", ") + ". JMCP tries again next time.";
  return out;
}

function readRetry(file) {
  try {
    const ids = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function retryFile(item, home) {
  return path.join(jmcpHome(home), "servers", item.id + ".retry.json");
}

// Every installed JMCP server older than this JMCP, updated. The app runs
// this when it starts.
async function updateAll(home) {
  const out = [];
  for (const item of CATALOG) {
    const v = versions(item, home);
    if (!v.updateAvailable && !(v.installed && fs.existsSync(retryFile(item, home)))) continue;
    try {
      out.push(await updateServer(item.id, home));
    } catch (e) {
      out.push({ ok: false, server: item.name, error: String(e.message || e) });
    }
  }
  return out;
}

// Every JMCP server into every agent found on this computer that does not
// have it yet. Agents that already have a server are left as they are.
async function installAll(home) {
  const found = agents.scan(home).filter((a) => a.present);
  const out = [];
  for (const item of CATALOG) {
    const missing = found.filter((a) => !a.servers.some((s) => s.name === item.name)).map((a) => a.id);
    if (!missing.length) continue;
    try {
      out.push(Object.assign({ ok: true }, await installServer(item.id, missing, home)));
    } catch (e) {
      out.push({ ok: false, server: item.name, error: String(e.message || e), results: [] });
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

module.exports = { CATALOG, catalogItem, alreadyIn, installServer, installAll, updateServer, updateAll, uninstallServer, catalogState, compareVersions, jmcpHome, nodeCommand };
