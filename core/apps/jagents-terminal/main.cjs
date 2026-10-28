"use strict";

// JMCP connection for JAgents Terminal. Adds Plugins menu commands and an
// in-app "jmcp" MCP server, so you and the agents in this window can list
// subagents and use every installed JMCP server. JMCP writes this plugin when
// it connects JAgents Terminal and removes it when you disconnect.

const path = require("node:path");
const lib = require("./lib.cjs");

const HEARTBEAT_MS = 60000;

function line(s) {
  return s.handle + " " + s.status + (s.provider ? " (" + s.provider + ")" : "");
}

// "- name: description" lines, as jmcp-skills and jmcp-memory list them.
function names(text) {
  return [...String(text).matchAll(/^- ([^:\n]+):/gm)].map((m) => m[1].trim());
}

exports.activate = (ctx) => {
  const clients = lib.createClients();
  const beat = () => {
    try {
      lib.heartbeat();
    } catch {
      /* JMCP shows the last time it worked */
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  ctx.dispose(() => {
    clearInterval(timer);
    clients.close();
  });

  const toast = (fn) => async () => {
    try {
      const text = await fn();
      ctx.notify(text);
      return text;
    } catch (e) {
      ctx.notify("JMCP: " + (e.message || e));
      throw e;
    }
  };

  const summary = {
    status() {
      const s = lib.servers();
      return "JMCP connected. " + (s.length ? s.length + " servers: " + s.map((x) => x.id).join(", ") : "No JMCP servers installed yet.");
    },
    subagents() {
      const list = lib.subagents(50);
      if (!list.length) return "JMCP: no subagents yet.";
      const live = list.filter((s) => lib.RUNNING.has(s.status));
      return "JMCP subagents: " + live.length + " working, " + list.length + " recent. " + (live.length ? live : list).slice(0, 3).map(line).join("; ");
    },
    async providers() {
      const r = await clients.call("subagents", "providers", {});
      if (r.isError) throw new Error(r.text);
      const ready = ((r.json && r.json.providers) || []).filter((p) => p.installed);
      return "JMCP subagent providers: " + (ready.map((p) => (p.shortNames && p.shortNames[0]) || p.provider).join(", ") || "none installed");
    },
    async rules() {
      const r = await clients.call("rules", "rules", {});
      if (r.isError) throw new Error(r.text);
      const n = (r.text.match(/^\s*- /gm) || []).length;
      return "JMCP rules: " + n + " active. Agents in this window get them through jmcp-rules.";
    },
    async skills() {
      const r = await clients.call("skills", "skills_list", {});
      if (r.isError) throw new Error(r.text);
      const list = names(r.text);
      return "JMCP skills: " + (list.length ? list.join(", ") : "none yet");
    },
    async memories() {
      const r = await clients.call("memory", "memory_search", { query: "" });
      if (r.isError) throw new Error(r.text);
      const list = names(r.text);
      return "JMCP memories: " + (list.length ? list.join(", ") : "none yet");
    },
  };

  const reg = (id, label, fn) => ctx.terminal.commands.register({ id, label, handler: toast(fn) });
  reg("status", "JMCP: status", summary.status);
  reg("subagents", "JMCP: subagents", summary.subagents);
  reg("providers", "JMCP: subagent providers", summary.providers);
  reg("rules", "JMCP: rules", summary.rules);
  reg("skills", "JMCP: skills", summary.skills);
  reg("memories", "JMCP: memories", summary.memories);
  // A new tab, only when you pick it. Your other panes are left alone.
  ctx.terminal.commands.register({
    id: "view",
    label: "JMCP: open view in a new tab",
    handler: async () => {
      const pane = await ctx.terminal.open({ provider: "shell", name: "JMCP", mode: "tab" });
      const view = path.join(__dirname, "view.cjs");
      await ctx.terminal.write({ id: pane.id, text: "& '" + process.execPath.replace(/'/g, "''") + "' '" + view.replace(/'/g, "''") + "'", enter: true });
      return "JMCP view opened in tab " + pane.name;
    },
  });

  const obj = (properties, required) => ({ type: "object", properties: properties || {}, required: required || [] });
  const srv = ctx.mcp.server("jmcp", { description: "JMCP from JAgents Terminal: list subagents, see JMCP servers, and call any installed JMCP server tool." });
  srv.tool({
    name: "status",
    description: "JMCP servers installed on this computer, and which ones this window has running.",
    inputSchema: obj(),
    handler: () => ({ connected: true, jmcpHome: lib.jmcpHome(), plugin: lib.version(), servers: lib.servers(), running: clients.running().map((id) => "jmcp-" + id) }),
  });
  srv.tool({
    name: "subagents",
    description: "Subagents started through jmcp-subagents by any agent, newest first, with status and task.",
    inputSchema: obj({ limit: { type: "number", description: "Most rows (default 20, max 200)" } }),
    handler: (a) => ({ subagents: lib.subagents(a && a.limit) }),
  });
  srv.tool({
    name: "tools",
    description: "List the tools of one installed JMCP server, for example subagents, memory, rules, skills, health or browser.",
    inputSchema: obj({ server: { type: "string" } }, ["server"]),
    handler: async (a) => ({ server: "jmcp-" + a.server, tools: await clients.tools(String(a.server).replace(/^jmcp-/, "")) }),
  });
  srv.tool({
    name: "call",
    description: "Call a tool of an installed JMCP server, for example server subagents, tool spawn. The server keeps running in this window, so wait, send and read work on subagents it started.",
    inputSchema: obj({ server: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } }, ["server", "tool"]),
    handler: async (a) => {
      const r = await clients.call(String(a.server).replace(/^jmcp-/, ""), String(a.tool), a.arguments || {});
      if (r.isError) throw new Error(r.text || "The JMCP tool failed.");
      return r.json !== null ? r.json : { text: r.text };
    },
  });
};
