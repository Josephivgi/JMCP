#!/usr/bin/env node
"use strict";

// JMCP Subagents: an MCP server (stdio) that lets any coding agent start
// subagents from other providers: Claude Code, Codex, Factory Droid, Devin,
// Cursor, OpenCode, Gemini, Qwen, Grok, Copilot and more. Ported from the
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
      "CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, parent TEXT, pid INTEGER, cwd TEXT, started_at INTEGER, ended_at INTEGER);",
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

function push(s, row) {
  s.rows.push(Object.assign({ at: Date.now() }, row));
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
        if (u.title) r.text = String(u.title);
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

function stopClient(s) {
  if (!s.client) return;
  const c = s.client;
  s.client = null;
  try {
    c.stop();
  } catch {
    /* already gone */
  }
}

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
  let client = null;
  client = openClient(s.provider, s.cwd, (p) => s.client === client && onUpdate(s, p), s.handle);
  s.client = client;
  s.status = "starting";
  const onExit = () => {
    if (s.client !== client) return;
    s.client = null;
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
        throw new Error(s.providerName + " is not signed in. Sign in with its own CLI first (" + errText(authErr) + ").");
      }
      created = await client.newSession({ cwd: s.cwd, mcpServers: [] });
    }
    s.sessionId = created.sessionId || created.session_id || "";
    if (!client.sessionId) client.sessionId = s.sessionId;
    if (s.want.model) {
      try {
        await client.setModel(s.want.model, client.sessionId);
      } catch (e) {
        push(s, { role: "system", text: "Model " + s.want.model + " not used: " + errText(e) });
      }
    }
    if (s.want.effort && typeof client.setEffort === "function") {
      try {
        await client.setEffort(s.want.effort, client.sessionId);
      } catch (e) {
        push(s, { role: "system", text: "Effort " + s.want.effort + " not used: " + errText(e) });
      }
    }
    const st = typeof client.effortState === "function" ? client.effortState() : {};
    s.using = { model: (client.models && client.models.currentModelId) || "", effort: st.current || "" };
  } catch (e) {
    stopClient(s);
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

async function runTurn(s, text) {
  s.status = "starting";
  if (!s.client) await startSession(s);
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
    if (res && res.stopReason === "cancelled") push(s, { role: "system", text: "Stopped by " + parentName + "." });
    s.status = s.client ? "ready" : "stopped";
  } catch (e) {
    push(s, { role: "error", text: errText(e) });
    s.status = s.client && s.client.started ? "ready" : "error";
    s.error = errText(e);
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
  runTurn(s, text).catch((e) => {
    s.status = "error";
    s.error = errText(e);
    push(s, { role: "error", text: s.error });
    s.updatedAt = Date.now();
    save(s, true);
    finishTurn(s, "error");
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

function view(s, replyMax) {
  return {
    handle: s.handle, provider: s.provider, providerName: s.providerName, status: s.status, error: s.error || undefined,
    task: s.task.slice(0, 600), cwd: s.cwd, queued: s.queue.length || undefined,
    model: s.using.model || s.want.model || undefined, effort: s.using.effort || s.want.effort || undefined,
    reply: lastReply(s).slice(0, replyMax || 600),
  };
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
  const live = [...subs.values()].filter((s) => s.client || busy(s)).length;
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
  if (args.wait === false) return Object.assign(view(s), { note: "Call wait with agent " + s.handle + " for its reply." });
  const why = await waitFor(s, clampWait(args.timeout_seconds));
  return Object.assign(view(s, TEXT_MAX), why === "timeout" ? { hint: "Still working. Call wait with agent " + s.handle + "." } : {});
}

// ---- Tools ----

const PROVIDER_LIST = "claude, codex, droid, devin, cursor, opencode, gemini, qwen, grok, copilot, kilo, goose, cline, kimi";

const TOOLS = [
  {
    name: "providers",
    description: "Agents you can start as subagents and whether each is installed on this computer. Short names: " + PROVIDER_LIST + ".",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ you: parentName, providers: require("./lib/agents").listAgents().map((a) => ({ provider: a.id, shortNames: a.aliases.length ? a.aliases : undefined, name: a.name, installed: a.installed, install: a.install || undefined })) }),
  },
  {
    name: "spawn",
    description:
      "Start a subagent from any installed provider (" + PROVIDER_LIST + ") on a task. It runs hidden in the background, works in cwd, and only you can message, read, wait on or stop it. It cannot start agents itself. With wait (default true) this returns its reply when it finishes or after timeout_seconds.",
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
    description: "Your subagents with their status and the start of their latest reply.",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ you: parentName, subagents: [...subs.values()].map((s) => view(s)) }),
  },
  {
    name: "wait",
    description: "Wait until one of your subagents finishes its turn, then return its reply.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, timeout_seconds: { type: "number", description: "Default 50, max 1800" } }, required: ["agent"] },
    run: async (args) => {
      const s = own(args.agent);
      const why = await waitFor(s, clampWait(args.timeout_seconds));
      return Object.assign(view(s, TEXT_MAX), why === "timeout" ? { hint: "Still working. Call wait again." } : {});
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
    description: "Read one of your subagents' transcript: your messages, its replies and its tool calls.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, limit: { type: "number", description: "Rows from the end (default 30)" } }, required: ["agent"] },
    run: (args) => {
      const s = own(args.agent);
      const n = Math.min(ROWS_MAX, Math.max(1, Number(args.limit) || 30));
      return Object.assign(view(s), { rows: s.rows.slice(-n).map((r) => ({ role: r.role, text: String(r.text).slice(0, 4000), status: r.status })) });
    },
  },
  {
    name: "stop",
    description: "Stop one of your subagents' current turn. close: true ends its session; remove: true also deletes its record.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, close: { type: "boolean" }, remove: { type: "boolean" } }, required: ["agent"] },
    run: async (args) => {
      const s = own(args.agent);
      s.queue.length = 0;
      if (s.client && s.status === "busy") {
        try {
          await s.client.cancel(s.sessionId);
        } catch {
          /* nothing running */
        }
      }
      if (args.close || args.remove) {
        stopClient(s);
        s.status = "stopped";
        s.updatedAt = Date.now();
        finishTurn(s, "stopped");
      }
      if (args.remove) {
        subs.delete(s.handle);
        dbRun(() => q.del.run(SESSION, s.handle));
      } else save(s, true);
      return { handle: s.handle, stopped: true, closed: Boolean(args.close || args.remove), removed: Boolean(args.remove) };
    },
  },
];

const INSTRUCTIONS = IS_SUBAGENT
  ? "You are running as a JMCP subagent, so this server offers no tools: subagents cannot start subagents."
  : "JMCP Subagents lets you start other coding agents (" + PROVIDER_LIST + ") as your own subagents. Use providers to see what is installed, spawn to start one on a task (start several with wait: false to run them at once), and wait/send/read/stop to work with them.";

// ---- MCP over stdio ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError: false };
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      const ci = (params && params.clientInfo) || {};
      if (ci.name) parentName = String(ci.name).slice(0, 60);
      if (!IS_SUBAGENT) dbRun(() => q.session.run(SESSION, parentName, process.pid, process.cwd(), Date.now()));
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-subagents", title: "JMCP Subagents", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: IS_SUBAGENT ? [] : TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    if (method === "tools/call") {
      const tool = IS_SUBAGENT ? null : TOOLS.find((t) => t.name === (params && params.name));
      if (!tool) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: IS_SUBAGENT ? INSTRUCTIONS : "Unknown tool " + (params && params.name) }], isError: true } });
      try {
        return send({ jsonrpc: "2.0", id, result: result(await tool.run((params && params.arguments) || {})) });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: errText(e) }], isError: true } });
      }
    }
    if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
    if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    if (!isRequest) return;
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: errText(e) } });
  }
}

let ending = false;
function shutdown() {
  if (ending) return;
  ending = true;
  for (const s of subs.values()) {
    stopClient(s);
    if (["busy", "starting", "ready", "idle"].includes(s.status)) s.status = "stopped";
    save(s, true);
  }
  dbRun(() => {
    q.endSubs.run(SESSION);
    q.endSession.run(Date.now(), SESSION);
  });
  setTimeout(() => process.exit(0), 300);
}

if (require.main === module) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (Array.isArray(msg)) msg.forEach(handle);
      else handle(msg);
    }
  });
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { TOOLS, handle };
