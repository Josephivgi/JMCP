#!/usr/bin/env node
"use strict";

// Shared memory for every agent. Reads and writes ~/.jmcp/memory.db on each
// call, so a memory one agent saves is there for the next one at once.

const store = require("./lib/store.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const str = (description) => ({ type: "string", description });
const TOOLS = [
  {
    name: "memory_search",
    description: "Find saved memories by words in their name, title, body or tags. Search before starting work that may depend on the user's preferences, past decisions or project facts.",
    inputSchema: { type: "object", properties: { query: str("Words to look for. Empty lists the newest memories."), limit: { type: "number", description: "Most results (default 10)" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_read",
    description: "Read one memory in full by its name.",
    inputSchema: { type: "object", properties: { name: str("Memory name, e.g. prefers-sqlite") }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_save",
    description: "Save something worth remembering across sessions and agents: a user preference, a correction, a decision and why, a project fact that is not in the code. Saving with an existing name replaces that memory, so read it first and keep what still holds. Do not save secrets or things the repo already records.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Short kebab-case name. Defaults to one made from the title."),
        title: str("One line: what this memory is"),
        body: str("The memory itself. Plain text or Markdown."),
        tags: { type: "array", items: { type: "string" }, description: "A few topic tags" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory that turned out to be wrong or no longer applies.",
    inputSchema: { type: "object", properties: { name: str("Memory name") }, required: ["name"] },
    annotations: { destructiveHint: true },
  },
];

let client = "";

function full(m) {
  return "# " + m.title + "\nname: " + m.name + (m.tags.length ? "\ntags: " + m.tags.join(", ") : "") + "\nsaved by " + m.author + ", " + new Date(m.updated_at).toISOString().slice(0, 10) + "\n\n" + m.body;
}

function call(name, a) {
  a = a || {};
  if (name === "memory_search") {
    const found = store.search(undefined, a.query, Math.min(50, Math.max(1, Number(a.limit) || 10)));
    if (!found.length) return a.query ? "No memories match \"" + a.query + "\"." : "No memories saved yet.";
    return found.map((m) => "- " + m.name + ": " + m.title + (m.tags.length ? " [" + m.tags.join(", ") + "]" : "") + "\n  " + m.body.replace(/\s+/g, " ").slice(0, 160)).join("\n");
  }
  if (name === "memory_read") {
    const m = store.get(undefined, a.name);
    if (!m) throw new Error("No memory named " + a.name + ". Use memory_search to find it.");
    return full(m);
  }
  if (name === "memory_save") {
    const r = store.save(undefined, { name: a.name, title: a.title, body: a.body, tags: a.tags, author: client || "an agent" });
    return (r.created ? "Saved new memory " : "Replaced memory ") + r.memory.name + ".";
  }
  if (name === "memory_delete") {
    if (!store.remove(undefined, a.name)) throw new Error("No memory named " + a.name + ".");
    return "Deleted memory " + store.slug(a.name) + ".";
  }
  throw new Error("Unknown tool " + name);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      client = String((params && params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
      const all = store.list();
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jmcp-memory", title: "JMCP Memory", version: VERSION },
          instructions:
            "Shared memory for every agent the user runs, managed in the JMCP app. Search it before work that may depend on the user's preferences or past decisions, and save what a future session should know." +
            (all.length ? "\n\nSaved memories (read one with memory_read):\n" + store.index(all) : "\n\nNo memories are saved yet."),
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: call(params && params.name, params && params.arguments) }], isError: false } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
      }
    }
    if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
    if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    if (!isRequest) return;
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
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
}

module.exports = { handle };
