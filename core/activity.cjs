"use strict";

// What jmcp-subagents has done, read from its database (~/.jmcp/subagents.db)
// for the app's Activity panel. Read-only.

const fs = require("node:fs");
const path = require("node:path");
const { jmcpHome } = require("./catalog.cjs");

function activity(home, limit) {
  const file = path.join(jmcpHome(home), "subagents.db");
  if (!fs.existsSync(file)) return { sessions: [], subagents: [], workflows: [] };
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const has = (t) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
    const sessions = has("sessions") ? db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(n) : [];
    const subagents = has("subagents")
      ? db.prepare("SELECT session, handle, parent, provider, provider_name, task, cwd, status, error, model, effort, workflow, created_at, updated_at, transcript FROM subagents ORDER BY updated_at DESC LIMIT ?").all(n).map((r) => {
          let rows = [];
          try {
            rows = JSON.parse(r.transcript || "[]");
          } catch {
            rows = [];
          }
          const reply = [...rows].reverse().find((x) => x.role === "assistant");
          const { transcript, ...rest } = r;
          return Object.assign(rest, { reply: reply ? String(reply.text).slice(0, 2000) : "", tools: rows.filter((x) => x.role === "tool").length, rows: rows.slice(-60).map((x) => ({ role: x.role, text: String(x.text).slice(0, 2000), status: x.status })) });
        })
      : [];
    const workflows = has("workflows")
      ? db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC LIMIT ?").all(n).map((w) => {
          let steps = [];
          try {
            steps = JSON.parse(w.steps || "[]");
          } catch {
            steps = [];
          }
          return Object.assign({}, w, { steps });
        })
      : [];
    return { sessions, subagents, workflows };
  } finally {
    db.close();
  }
}

module.exports = { activity };
