#!/usr/bin/env node
"use strict";

// JMCP Subagents: an MCP server (stdio) that lets any coding agent start
// subagents from other providers: Claude Code, Codex, Factory Droid, Devin,
// Cursor, OpenCode, Gemini, Qwen, Grok and more. Ported from the
// JAgents Subagents plugin, but it needs no app: the agent that runs this
// server is the parent, and its subagents run as hidden child processes of
// this server.
//
// A subagent cannot start subagents of its own. Every subagent process gets
// JMCP_SUBAGENT set; when this server starts with it set (because the
// subagent's own config also lists jmcp-subagents), it offers no tools.
// Claude Code subagents also get --strict-mcp-config with no servers.
//
// Records and transcripts are kept in SQLite (~/.jmcp/subagents.db) so the
// JMCP app can show them. Subagents end when the parent's session ends.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const JMCP_HOME = process.env.JMCP_HOME ? path.resolve(process.env.JMCP_HOME) : path.join(os.homedir(), ".jmcp");
const WAIT_DEFAULT_S = 50;
const WAIT_MAX_S = 1800;
const MAX_LIVE = Math.max(1, Number(process.env.JMCP_MAX_SUBAGENTS) || 6);
const ROWS_MAX = 400;
const TEXT_MAX = 20000;
// auto: allow each tool call once (default). full: allow always. edits: reads
// and edits only. deny: deny everything that asks.
const PERMISSIONS = String(process.env.JMCP_PERMISSIONS || "auto").toLowerCase();
const IS_SUBAGENT = Boolean(process.env.JMCP_SUBAGENT);
// Claude Code built-ins that start, schedule or message agents.
const CLAUDE_BLOCKED_TOOLS = ["Agent", "Task", "SendMessage", "ListAgents", "TaskStop", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "TeamCreate", "TeamDelete", "Workflow", "mcp__jmcp-subagents"];

const SILENT_AUTH = { codex: "chat-gpt-device-code" };

const clampWait =(s, def) => Math.min(WAIT_MAX_S, Math.max(1, Number(s) > 0 ? Number(s) : def || WAIT_DEFAULT_S)) * 1000;
const errText = (e) => String((e && e.message) || e);

// ---- Storage ----

let db = null;
let q = null;
function openDb() {
  if (db) return;
  fs.mkdirSync(JMCP_HOME, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(JMCP_HOME, "subagents.db"));
  // The workflow column is left from 0.1 (which had workflows) and stays empty.
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" +
      "CREATE TABLE IF NOT EXISTS subagents (session TEXT NOT NULL, handle TEXT NOT NULL, parent TEXT, provider TEXT, provider_name TEXT, task TEXT, cwd TEXT, status TEXT, error TEXT, model TEXT, effort TEXT, workflow TEXT, created_at INTEGER, updated_at INTEGER, transcript TEXT, PRIMARY KEY (session, handle));" +
      "CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, parent TEXT, pid INTEGER, cwd TEXT, started_at INTEGER, ended_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS models (provider TEXT PRIMARY KEY, models TEXT, current TEXT, efforts TEXT, error TEXT, checked_at INTEGER);",
  );
  q = {
    upsert: db.prepare(
      "INSERT INTO subagents (session, handle, parent, provider, provider_name, task, cwd, status, error, model, effort, workflow, created_at, updated_at, transcript) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(session, handle) DO UPDATE SET status=excluded.status, error=excluded.error, model=excluded.model, effort=excluded.effort, updated_at=excluded.updated_at, transcript=excluded.transcript",
    ),
    del: db.prepare("DELETE FROM subagents WHERE session = ? AND handle = ?"),
    session: db.prepare("INSERT INTO sessions (session, parent, pid, cwd, started_at) VALUES (?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET parent=excluded.parent"),
    endSession: db.prepare("UPDATE sessions SET ended_at = ? WHERE session = ?"),
    endSubs: db.prepare("UPDATE subagents SET status = 'stopped' WHERE session = ? AND status IN ('busy','starting','ready','idle')"),
    models: db.prepare("SELECT provider, models, current, efforts, error, checked_at FROM models"),
    // An error keeps the last good list: a provider that fails once still
    // shows what it offered before.
    saveModels: db.prepare(
      "INSERT INTO models (provider, models, current, efforts, error, checked_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(provider) DO UPDATE SET models=CASE WHEN excluded.error = '' THEN excluded.models ELSE models END, current=CASE WHEN excluded.error = '' THEN excluded.current ELSE current END, efforts=CASE WHEN excluded.error = '' THEN excluded.efforts ELSE efforts END, error=excluded.error, checked_at=excluded.checked_at",
    ),
  };
}

const SESSION = crypto.randomUUID();
let parentName = "agent";

function dbRun(fn) {
  try {
    openDb();
    fn();
  } catch (e) {
    if (process.env.JMCP_DEBUG) process.stderr.write("jmcp-subagents: db " + errText(e) + "\n");
  }
}

// ---- Subagents ----

const subs = new Map();
const saveTimers = new Map();

function save(s, now) {
  clearTimeout(saveTimers.get(s.handle));
  const run = () => {
    saveTimers.delete(s.handle);
    if (!subs.has(s.handle)) return;
    dbRun(() =>
      q.upsert.run(SESSION, s.handle, parentName, s.provider, s.providerName, s.task, s.cwd, s.status, s.error, s.using.model || s.want.model || "", s.using.effort || s.want.effort || "", "", s.createdAt, s.updatedAt, JSON.stringify(s.rows.slice(-ROWS_MAX))),
    );
  };
  if (now) run();
  else saveTimers.set(s.handle, setTimeout(run, 1000));
}

// Every row is clipped: a huge message, error or tool title must not grow
// the transcript (memory and the saved row) without bound.
function push(s, row) {
  s.rows.push(Object.assign({ at: Date.now() }, row, { text: String(row.text == null ? "" : row.text).slice(0, row.role === "tool" ? 500 : TEXT_MAX) }));
  if (s.rows.length > ROWS_MAX) s.rows.splice(0, s.rows.length - ROWS_MAX);
}

function onUpdate(s, params) {
  const u = (params && params.update) || {};
  const kind = u.sessionUpdate;
  const last = s.rows[s.rows.length - 1];
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const text = u.content && u.content.type === "text" ? String(u.content.text || "") : "";
    if (!text) return;
    const role = kind === "agent_message_chunk" ? "assistant" : "thought";
    if (last && last.role === role) last.text = (last.text + text).slice(-TEXT_MAX);
    else push(s, { role, text });
  } else if (kind === "tool_call") {
    push(s, { role: "tool", id: u.toolCallId, text: String(u.title || "tool"), status: u.status || "in_progress" });
  } else if (kind === "tool_call_update") {
    for (let i = s.rows.length - 1; i >= 0; i--) {
      const r = s.rows[i];
      if (r.role === "tool" && r.id === u.toolCallId) {
        if (u.status) r.status = u.status;
        if (u.title) r.text = String(u.title).slice(0, 500);
        break;
      }
    }
  } else return;
  s.updatedAt = Date.now();
  save(s);
}

function finishTurn(s, why) {
  for (const fn of [...s.waiters]) fn(why);
}

// Kills still running. shutdown waits for every one, including kills that
// stop and agent exits started earlier.
const kills = new Set();

function endClient(c) {
  let p;
  try {
    p = Promise.resolve(c.stop()).catch(() => {});
  } catch {
    p = Promise.resolve();
  }
  kills.add(p);
  p.then(() => kills.delete(p));
  return p;
}

// Returns a promise that resolves once the agent's processes are killed.
function stopClient(s) {
  if (!s.client) return Promise.resolve();
  const c = s.client;
  s.client = null;
  return endClient(c);
}

const STOPPED = "Stopped before it started.";
const liveCount = (except) => [...subs.values()].filter((x) => x !== except && (x.client || busy(x))).length;

function permissionAnswer(params) {
  const { autoPermissionOption } = require("./lib/acp-permissions");
  if (PERMISSIONS === "deny") return { outcome: { outcome: "selected", optionId: rejectId(params) } };
  const id = autoPermissionOption(PERMISSIONS === "edits" || PERMISSIONS === "full" ? PERMISSIONS : "auto", params);
  return { outcome: { outcome: "selected", optionId: id || rejectId(params) } };
}

function rejectId(params) {
  const { listPermissionOptions } = require("./lib/acp-permissions");
  const opts = listPermissionOptions(params);
  const r = opts.find((o) => /reject|deny/i.test(String((o && (o.kind || o.optionId)) || "")));
  return r ? r.optionId || r.id : "reject_once";
}

// Cursor saves its model and effort in its config folder, so each Cursor
// subagent gets its own copy of the user's Cursor sign-in and settings.
function cursorConfig(key) {
  const dir = path.join(JMCP_HOME, "cursor", String(key).replace(/[^\w.-]+/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"), "cli-config.json");
  try {
    fs.copyFileSync(src, path.join(dir, "cli-config.json"));
  } catch {
    /* not signed in yet; Cursor says so */
  }
  return dir;
}

function openClient(providerId, cwd, onUpd, key) {
  const agents = require("./lib/agents");
  const a = agents.agent(providerId);
  const spec = agents.spawnSpec(providerId);
  const onPermission = async (params) => permissionAnswer(params);
  const opts = { harnessId: a.id, dataRoot: JMCP_HOME, cwd, mcpServers: [], disallowedTools: CLAUDE_BLOCKED_TOOLS, onUpdate: onUpd || (() => {}), onPermission, permissionMode: PERMISSIONS === "full" ? "full" : PERMISSIONS === "edits" ? "edits" : "ask" };
  let client;
  if (a.native === "claude-sdk") {
    const { ClaudeSdkClient } = require("./lib/claude-sdk-client");
    // Only the MCP servers passed in (none), not the user's ~/.claude.json ones.
    class SubagentClaude extends ClaudeSdkClient {
      _spawn(o) {
        const args = (o.args || []).includes("--strict-mcp-config") ? o.args : [...(o.args || []), "--strict-mcp-config"];
        return super._spawn(Object.assign({}, o, { args }));
      }
    }
    client = new SubagentClaude(opts);
  } else {
    const { AcpClient } = require("./lib/acp-client");
    client = new AcpClient(opts);
  }
  const env = Object.assign({}, spec.env, { JMCP_SUBAGENT: key || "1", JMCP_SUBAGENT_PARENT: parentName });
  if (a.id === "cursor") env.CURSOR_CONFIG_DIR = cursorConfig(SESSION.slice(0, 8) + "-" + (key || "x"));
  client.start({ command: spec.command, args: spec.args, cwd, env });
  return client;
}

async function startSession(s) {
  // Restarts count against the limit too, not only spawn.
  const live = liveCount(s);
  if (live >= MAX_LIVE) throw new Error("You already have " + live + " running subagents (limit " + MAX_LIVE + "). Stop one with close: true first.");
  let client = null;
  client = openClient(s.provider, s.cwd, (p) => s.client === client && onUpdate(s, p), s.handle);
  s.client = client;
  s.status = "starting";
  // stop clears s.client; every await below checks it so a stop during
  // start ends the start instead of bringing the agent up anyway.
  const alive = () => {
    if (s.client === client) return;
    const e = new Error(STOPPED);
    e.stopped = true;
    throw e;
  };
  const onExit = () => {
    if (s.client !== client) return;
    s.client = null;
    // Tools it started may still run; take them down too.
    endClient(client);
    if (s.status === "busy") {
      s.status = "error";
      s.error = "The agent exited mid-turn.";
    } else s.status = "stopped";
    s.updatedAt = Date.now();
    save(s, true);
    finishTurn(s, s.status);
  };
  if (typeof client.onExit === "function") client.onExit(onExit);
  else if (client.child) client.child.on("exit", onExit);
  try {
    await client.initialize();
    alive();
    let created;
    try {
      created = await client.newSession({ cwd: s.cwd, mcpServers: [] });
    } catch (e) {
      // Reuse a sign-in the agent already has. Only methods that never open a
      // browser: codex-acp's device-code method just reads the saved ChatGPT
      // login and fails (no window) when there is none.
      const method = SILENT_AUTH[s.provider];
      if (!method || !/auth/i.test(errText(e))) throw e;
      try {
        await client.authenticate(method);
      } catch (authErr) {
        alive();
        throw new Error(s.providerName + " is not signed in. Sign in with its own CLI first (" + errText(authErr) + ").");
      }
      alive();
      created = await client.newSession({ cwd: s.cwd, mcpServers: [] });
    }
    alive();
    s.sessionId = created.sessionId || created.session_id || "";
    if (!client.sessionId) client.sessionId = s.sessionId;
    if (s.want.model) {
      try {
        await client.setModel(s.want.model, client.sessionId);
      } catch (e) {
        alive();
        push(s, { role: "system", text: "Model " + s.want.model + " not used: " + errText(e) });
      }
    }
    if (s.want.effort && typeof client.setEffort === "function") {
      try {
        await client.setEffort(s.want.effort, client.sessionId);
      } catch (e) {
        alive();
        push(s, { role: "system", text: "Effort " + s.want.effort + " not used: " + errText(e) });
      }
    }
    alive();
    const st = typeof client.effortState === "function" ? client.effortState() : {};
    s.using = { model: (client.models && client.models.currentModelId) || "", effort: st.current || "" };
  } catch (e) {
    if (s.client === client) stopClient(s);
    else if (!e.stopped) e = Object.assign(new Error(STOPPED), { stopped: true });
    throw e;
  }
  s.sessionUsed = false;
  s.status = "ready";
  s.error = "";
}

function intro(s) {
  return (
    "You are " + s.handle + ", a subagent started by " + parentName + " through JMCP. " + parentName + " gives you your work and reads your replies. " +
    "You cannot start agents or message other agents. If you need something from anyone else, say so in your reply. " +
    "Work in " + s.cwd + ". When you finish, reply with a short summary of what you did and found."
  );
}

function recap(s) {
  const last = s.rows.filter((r) => r.role === "user" || r.role === "assistant").slice(-6);
  if (!last.length) return "";
  return "Your earlier session ended. The last messages were:\n" + last.map((r) => (r.role === "user" ? parentName + ": " : "You: ") + String(r.text).slice(0, 1500)).join("\n\n");
}

// gen is this turn's generation. stop with close and every new turn change
// s.gen, so a turn that finishes after that leaves the subagent alone.
async function runTurn(s, text, gen) {
  s.status = "starting";
  if (!s.client) await startSession(s);
  if (s.gen !== gen) return;
  const parts = [];
  if (!s.introduced) parts.push(intro(s));
  else if (!s.sessionUsed) {
    parts.push(intro(s));
    const r = recap(s);
    if (r) parts.push(r);
  }
  parts.push((parts.length ? "Message from " + parentName + ":\n" : "") + text);
  s.introduced = true;
  s.sessionUsed = true;
  push(s, { role: "user", text });
  s.status = "busy";
  s.updatedAt = Date.now();
  save(s, true);
  try {
    const res = await s.client.promptWithRecovery(parts.join("\n\n"), s.sessionId, {});
    if (s.gen !== gen) return;
    if (res && res.stopReason === "cancelled") push(s, { role: "system", text: "Stopped by " + parentName + "." });
    s.status = s.client ? "ready" : "stopped";
  } catch (e) {
    if (s.gen !== gen) return;
    // The agent may be half broken after a failed turn: end its session so
    // the next message starts a fresh one with a recap. Messages queued
    // behind the failed turn are dropped, not fed to a broken agent.
    push(s, { role: "error", text: errText(e) });
    stopClient(s);
    s.status = "error";
    s.error = errText(e);
    if (s.queue.length) push(s, { role: "system", text: s.queue.length + " queued message(s) were not sent because the turn failed." });
    s.queue.length = 0;
  }
  s.updatedAt = Date.now();
  save(s, true);
  const next = s.queue.shift();
  if (next) deliver(s, next);
  else finishTurn(s, s.status);
}

function deliver(s, text) {
  if (s.status === "busy" || s.status === "starting") {
    s.queue.push(text);
    return { queued: s.queue.length };
  }
  const gen = (s.gen = (s.gen || 0) + 1);
  runTurn(s, text, gen).catch((e) => {
    // A stop or a newer turn owns the subagent now.
    if (s.gen !== gen) return;
    // Start failed. Queued messages cannot be delivered, so they go too;
    // otherwise busy() stays true and every wait times out.
    s.queue.length = 0;
    if (e && e.stopped) s.status = "stopped";
    else {
      s.status = "error";
      s.error = errText(e);
      push(s, { role: "error", text: s.error });
    }
    s.updatedAt = Date.now();
    save(s, true);
    finishTurn(s, s.status);
  });
  return { queued: 0 };
}

function lastReply(s) {
  for (let i = s.rows.length - 1; i >= 0; i--) {
    const r = s.rows[i];
    if (r.role === "user") break;
    if (r.role === "assistant" && r.text.trim()) return r.text.trim();
  }
  return "";
}

const busy = (s) => s.status === "busy" || s.status === "starting" || s.queue.length > 0;

function waitFor(s, ms) {
  if (!busy(s)) return Promise.resolve("idle");
  return new Promise((resolve) => {
    const fn = () => {
      if (busy(s)) return;
      clearTimeout(t);
      s.waiters.delete(fn);
      resolve("done");
    };
    const t = setTimeout(() => {
      s.waiters.delete(fn);
      resolve("timeout");
    }, ms);
    s.waiters.add(fn);
  });
}

// Every result lands in the parent's context, so a view carries only what
// the parent does not have already: no task (it wrote it) unless asked for.
// replyMax 0 leaves the reply out.
function view(s, replyMax, taskMax) {
  const reply = replyMax === 0 ? "" : lastReply(s).slice(0, replyMax || 300);
  return {
    handle: s.handle, provider: s.provider, status: s.status, error: s.error || undefined,
    task: taskMax ? s.task.slice(0, taskMax) : undefined, queued: s.queue.length || undefined,
    model: s.using.model || s.want.model || undefined, effort: s.using.effort || s.want.effort || undefined,
    reply: reply || undefined,
  };
}

// The end of what it is saying now and its latest tool call, so a wait that
// times out shows progress without repeating the whole reply each time.
function progress(s) {
  let said = "";
  let tool = "";
  for (let i = s.rows.length - 1; i >= 0; i--) {
    const r = s.rows[i];
    if (r.role === "user") break;
    if (!tool && r.role === "tool") tool = String(r.text).replace(/\s+/g, " ").slice(0, 160);
    if (!said && r.role === "assistant" && r.text.trim()) said = r.text.trim();
    if (tool && said) break;
  }
  return { saying: said ? (said.length > 300 ? "..." + said.slice(-300) : said) : undefined, lastTool: tool || undefined };
}

// A finished turn returns the full reply once; a timeout returns progress only.
function turnResult(s, why) {
  if (why !== "timeout") return view(s, TEXT_MAX);
  return Object.assign(view(s, 0), progress(s), { hint: "Still working. Call wait with agent " + s.handle + " again." });
}

// The transcript as plain lines, newest kept: rows from the end until
// max_chars is used. Thoughts are left out unless asked for, and a tool call
// is one short line.
function transcript(s, args) {
  const n = Math.min(ROWS_MAX, Math.max(1, Number(args.limit) || 30));
  const budget = Math.min(100000, Math.max(1000, Number(args.max_chars) || 12000));
  const picked = s.rows.slice(-n);
  const rows = args.thoughts ? picked : picked.filter((r) => r.role !== "thought");
  const label = (r) => (r.role === "user" ? "you" : r.role === "assistant" ? s.handle : r.role === "tool" ? "tool" + (r.status && r.status !== "completed" ? " " + r.status : "") : r.role);
  const out = [];
  let used = 0;
  let left = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    let t = r.role === "tool" ? String(r.text).replace(/\s+/g, " ") : String(r.text).trim();
    const cap = r.role === "tool" ? 160 : 4000;
    if (t.length > cap) t = t.slice(0, cap) + "...";
    const line = "[" + label(r) + "] " + t;
    if (out.length && used + line.length > budget) {
      left = i + 1;
      break;
    }
    out.unshift(line);
    used += line.length + 1;
  }
  const head = [s.handle + " (" + s.provider + "): " + s.status + (s.error ? ", " + s.error : "")];
  if (left) head.push("(" + left + " earlier rows left out; raise max_chars to see them.)");
  if (rows.length < picked.length) head.push("(" + (picked.length - rows.length) + " thinking rows hidden; pass thoughts: true to see them.)");
  return head.join("\n") + "\n\n" + out.join("\n");
}

function own(ref) {
  const key = String(ref || "").trim().replace(/^@/, "");
  const s = subs.get(key);
  if (!s) throw new Error("No subagent " + key + ". Call list to see yours.");
  return s;
}

function nextHandle(provider) {
  const short = provider === "factory-droid" ? "droid" : provider === "claude-code" ? "claude" : provider;
  let n = 1;
  while (subs.has(short + "-" + n)) n++;
  return short + "-" + n;
}

function create(args) {
  const agents = require("./lib/agents");
  const task = String(args.task || "").trim();
  if (!task) throw new Error("task is empty.");
  const raw = String(args.provider || "").trim().toLowerCase();
  const a = agents.agent(raw);
  if (!a) throw new Error("Unknown provider " + raw + ". Call providers.");
  const info = agents.listAgents().find((x) => x.id === a.id);
  if (!info.installed) throw new Error(a.name + " is not installed. " + a.install);
  const live = liveCount();
  if (live >= MAX_LIVE) throw new Error("You already have " + live + " running subagents (limit " + MAX_LIVE + "). Stop one with close: true first.");
  const cwd = path.resolve(String(args.cwd || process.cwd()));
  if (!fs.existsSync(cwd)) throw new Error("Folder not found: " + cwd);
  const s = {
    handle: nextHandle(a.id), provider: a.id, providerName: a.name, task, cwd, status: "idle", error: "",
    want: { model: String(args.model || "").trim(), effort: String(args.effort || "").trim().toLowerCase() }, using: {},
    createdAt: Date.now(), updatedAt: Date.now(), rows: [], client: null, sessionId: "",
    waiters: new Set(), queue: [], introduced: false, sessionUsed: false,
  };
  subs.set(s.handle, s);
  save(s, true);
  return s;
}

async function spawn(args) {
  const s = create(args);
  deliver(s, s.task);
  if (args.wait === false) return Object.assign(view(s, 0), { note: "Call wait with agent " + s.handle + " for its reply." });
  return turnResult(s, await waitFor(s, clampWait(args.timeout_seconds)));
}

// ---- Model lists ----

// Each provider's models, read from the agent itself: start it hidden with
// no task, open a session, keep what it offers, end it. Kept in the models
// table, so later calls (and the JMCP app) answer from there at once.
const MODELS_STALE_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 90 * 1000;
const PROBES_AT_ONCE = 3;
const probing = new Map();
const probeQueue = [];
const probeClients = new Set();
let probesLive = 0;

function withTimeout(p, ms, why) {
  let t;
  return Promise.race([p, new Promise((_, no) => (t = setTimeout(() => no(new Error(why)), ms)))]).finally(() => clearTimeout(t));
}

async function readModelsOf(providerId) {
  const cwd = path.join(JMCP_HOME, "probe");
  fs.mkdirSync(cwd, { recursive: true });
  const client = openClient(providerId, cwd, null, "models");
  probeClients.add(client);
  try {
    await client.initialize();
    let created;
    try {
      created = await client.newSession({ cwd, mcpServers: [] });
    } catch (e) {
      const method = SILENT_AUTH[providerId];
      if (!method || !/auth/i.test(errText(e))) throw e;
      await client.authenticate(method);
      created = await client.newSession({ cwd, mcpServers: [] });
    }
    if (!client.sessionId) client.sessionId = (created && (created.sessionId || created.session_id)) || "";
    const m = client.models || {};
    const st = typeof client.effortState === "function" ? client.effortState() : {};
    return {
      models: (m.availableModels || []).map((x) => ({ id: x.modelId, name: x.name || x.modelId, ...(x.description ? { description: String(x.description).slice(0, 300) } : {}) })),
      current: m.currentModelId || "",
      efforts: (st.levels || []).map((l) => l.value),
    };
  } finally {
    probeClients.delete(client);
    await endClient(client);
  }
}

function probe(providerId) {
  if (probing.has(providerId)) return probing.get(providerId);
  const p = new Promise((done) => probeQueue.push({ providerId, done }));
  probing.set(providerId, p);
  pumpProbes();
  return p;
}

function pumpProbes() {
  while (probesLive < PROBES_AT_ONCE && probeQueue.length) {
    const { providerId, done } = probeQueue.shift();
    probesLive++;
    withTimeout(readModelsOf(providerId), PROBE_TIMEOUT_MS, "The agent did not start in " + PROBE_TIMEOUT_MS / 1000 + " seconds.")
      .then(
        (r) => dbRun(() => q.saveModels.run(providerId, JSON.stringify(r.models), r.current, JSON.stringify(r.efforts), "", Date.now())),
        (e) => dbRun(() => q.saveModels.run(providerId, "[]", "", "[]", errText(e).slice(0, 500), Date.now())),
      )
      .finally(() => {
        probesLive--;
        probing.delete(providerId);
        done();
        pumpProbes();
      });
  }
}

async function models(args) {
  const agents = require("./lib/agents");
  let list = agents.listAgents();
  if (args.provider) {
    const a = agents.agent(String(args.provider).trim().toLowerCase());
    if (!a) throw new Error("Unknown provider " + args.provider + ". Call providers.");
    list = list.filter((x) => x.id === a.id);
  }
  const saved = () => {
    const rows = new Map();
    dbRun(() => {
      for (const r of q.models.all()) rows.set(r.provider, r);
    });
    return rows;
  };
  const now = Date.now();
  const before = saved();
  const wanted = list.filter((a) => a.installed && (args.refresh || !before.has(a.id) || now - (before.get(a.id).checked_at || 0) > MODELS_STALE_MS));
  const runs = wanted.map((a) => probe(a.id));
  if (args.wait && runs.length) await Promise.all(runs);
  const rows = args.wait ? saved() : before;
  const parse = (text, empty) => {
    try {
      return JSON.parse(text);
    } catch {
      return empty;
    }
  };
  // Model descriptions only with details: true; a long list (OpenCode has
  // over 150 models) would cost the caller thousands of tokens otherwise.
  const shape = (m) => (args.details ? m : m.name && m.name !== m.id ? { id: m.id, name: m.name } : { id: m.id });
  return {
    providers: list.map((a) => {
      const r = rows.get(a.id);
      if (!a.installed && !r) return { provider: a.id, installed: false };
      return {
        provider: a.id,
        name: a.name,
        installed: a.installed,
        models: r ? parse(r.models, []).map(shape) : [],
        current: (r && r.current) || undefined,
        efforts: r ? parse(r.efforts, []) : [],
        checkedAt: (r && r.checked_at) || undefined,
        error: (r && r.error) || undefined,
        refreshing: probing.has(a.id) || undefined,
      };
    }),
  };
}

// ---- Tools ----

const PROVIDER_LIST = "claude, codex, droid, devin, cursor, opencode, gemini, qwen, grok, kilo, goose, cline, kimi";

const TOOLS = [
  {
    name: "providers",
    description: "Agents you can start as subagents and whether each is installed on this computer. Short names: " + PROVIDER_LIST + ".",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ you: parentName, providers: require("./lib/agents").listAgents().map((a) => ({ provider: a.id, shortNames: a.aliases.length ? a.aliases : undefined, name: a.name, installed: a.installed, install: a.install || undefined })) }),
  },
  {
    name: "models",
    description:
      "The models and effort levels each installed provider offers, read from the agent itself and kept for a day. Answers at once from what is kept; a provider never read or read over a day ago is read again in the background (refreshing: true), so call again later. refresh: true reads them again; wait: true waits for that (up to 90 seconds per provider).",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "One provider (id or short name); all when left out" },
        refresh: { type: "boolean", description: "Read the lists again now" },
        wait: { type: "boolean", description: "Wait for the lists being read" },
        details: { type: "boolean", description: "Include each model's description" },
      },
    },
    run: models,
  },
  {
    name: "spawn",
    description:
      "Start a subagent from any installed provider (" + PROVIDER_LIST + ") on a task. It runs hidden in the background, works in cwd, and only you can message, read, wait on or stop it. It cannot start agents itself. With wait (default true) this returns its reply when it finishes; after timeout_seconds it returns only a progress line, so call wait again.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id or short name, e.g. droid, codex, claude, devin, opencode" },
        task: { type: "string", description: "What it should do. Be specific; it does not see your conversation." },
        cwd: { type: "string", description: "Working folder (defaults to yours)" },
        model: { type: "string", description: "Model id for this subagent (optional)" },
        effort: { type: "string", description: "Effort level, e.g. low, medium, high (optional, where the provider has one)" },
        wait: { type: "boolean", description: "Wait for the reply (default true)" },
        timeout_seconds: { type: "number", description: "How long to wait (default 50, max 1800)" },
      },
      required: ["provider", "task"],
    },
    run: spawn,
  },
  {
    name: "list",
    description: "Your subagents with their status, the start of their task and the start of their latest reply.",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ you: parentName, subagents: [...subs.values()].map((s) => view(s, s.status === "stopped" ? 0 : 300, 160)) }),
  },
  {
    name: "wait",
    description: "Wait until one of your subagents finishes its turn, then return its reply. If it is still working at timeout_seconds, you get a short progress line instead; call wait again.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, timeout_seconds: { type: "number", description: "Default 50, max 1800" } }, required: ["agent"] },
    run: async (args) => {
      const s = own(args.agent);
      return turnResult(s, await waitFor(s, clampWait(args.timeout_seconds)));
    },
  },
  {
    name: "send",
    description: "Send a follow-up message to one of your subagents. If it is busy the message waits for its turn. A stopped subagent starts a new session with a recap.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, message: { type: "string" } }, required: ["agent", "message"] },
    run: (args) => {
      const s = own(args.agent);
      const text = String(args.message || "").trim();
      if (!text) throw new Error("message is empty.");
      const out = deliver(s, text);
      return { to: s.handle, queued: out.queued, note: out.queued ? "It is busy; your message is queued." : "Sent. Call wait for the reply." };
    },
  },
  {
    name: "read",
    description: "Read one of your subagents' transcript: your messages, its replies and its tool calls, newest last. Long transcripts keep the newest rows that fit in max_chars.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        limit: { type: "number", description: "Rows from the end (default 30)" },
        max_chars: { type: "number", description: "Most characters to return (default 12000, max 100000)" },
        thoughts: { type: "boolean", description: "Include its thinking (left out by default)" },
      },
      required: ["agent"],
    },
    run: (args) => transcript(own(args.agent), args),
  },
  {
    name: "stop",
    description: "Stop one of your subagents' current turn. close: true ends its session; remove: true also deletes its record.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, close: { type: "boolean" }, remove: { type: "boolean" } }, required: ["agent"] },
    run: async (args) => {
      const s = own(args.agent);
      s.queue.length = 0;
      const starting = s.status === "starting";
      if (s.client && s.status === "busy") {
        try {
          await s.client.cancel(s.sessionId);
        } catch {
          /* nothing running */
        }
      }
      // A stop while it is still starting ends the start: there is no turn
      // to cancel yet.
      if (args.close || args.remove || starting) {
        if (busy(s) || starting) push(s, { role: "system", text: "Stopped by " + parentName + "." });
        s.gen = (s.gen || 0) + 1;
        stopClient(s);
        s.status = "stopped";
        s.updatedAt = Date.now();
        finishTurn(s, "stopped");
      }
      if (args.remove) {
        subs.delete(s.handle);
        dbRun(() => q.del.run(SESSION, s.handle));
      } else save(s, true);
      return { handle: s.handle, stopped: true, closed: Boolean(args.close || args.remove || starting), removed: Boolean(args.remove) };
    },
  },
];

const INSTRUCTIONS = IS_SUBAGENT
  ? "You are running as a JMCP subagent, so this server offers no tools: subagents cannot start subagents."
  : "JMCP Subagents lets you start other coding agents (" + PROVIDER_LIST + ") as your own subagents. Use providers to see what is installed, spawn to start one on a task (start several with wait: false to run them at once), and wait/send/read/stop to work with them.";

// ---- MCP over stdio ----

// Compact JSON, and a reply as plain text after it: JSON escapes every
// newline and quote in a reply, and the caller pays for each character.
function result(value) {
  let text;
  if (typeof value === "string") text = value;
  else if (value && typeof value.reply === "string" && value.reply) {
    const rest = Object.assign({}, value, { reply: undefined });
    text = JSON.stringify(rest) + "\n\nReply:\n" + value.reply;
  } else text = JSON.stringify(value);
  return { content: [{ type: "text", text }], isError: false };
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    const ci = params.clientInfo || {};
    if (ci.name) parentName = String(ci.name).slice(0, 60);
    if (!IS_SUBAGENT) dbRun(() => q.session.run(SESSION, parentName, process.pid, process.cwd(), Date.now()));
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-subagents", title: "JMCP Subagents", version: VERSION },
      instructions: INSTRUCTIONS,
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: IS_SUBAGENT ? [] : TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }),
  async "tools/call"(params) {
    // A subagent sees no tools; tell it why instead of a bare protocol error.
    if (IS_SUBAGENT) return { content: [{ type: "text", text: INSTRUCTIONS }], isError: true };
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return { content: [{ type: "text", text: "Invalid arguments: " + wrong }], isError: true };
    try {
      return result(await tool.run(params.arguments || {}));
    } catch (e) {
      return { content: [{ type: "text", text: errText(e) }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

let ending = false;
function shutdown() {
  if (ending) return;
  ending = true;
  for (const s of subs.values()) {
    stopClient(s);
    if (["busy", "starting", "ready", "idle"].includes(s.status)) s.status = "stopped";
    save(s, true);
  }
  for (const c of probeClients) endClient(c);
  dbRun(() => {
    q.endSubs.run(SESSION);
    q.endSession.run(Date.now(), SESSION);
  });
  // Wait for the agents' process trees to be killed (at most 8 seconds), so
  // none outlive this server.
  const exit = () => process.exit(0);
  Promise.race([Promise.allSettled([...kills]), new Promise((r) => setTimeout(r, 8000))]).then(exit, exit);
}

if (require.main === module) {
  serve(methods, shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { TOOLS, methods, view, progress, turnResult, transcript, result };
