#!/usr/bin/env node
"use strict";

// Shared memory for every agent. Reads and writes ~/.jmcp/memory.db on each
// call, so a memory one agent saves is there for the next one at once.

const store = require("./lib/store.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
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
    const m = store.get(undefined, a.name, { byName: true });
    if (!m) throw new Error("No memory named " + a.name + ". Use memory_search to find it.");
    return full(m);
  }
  if (name === "memory_save") {
    const secret = store.findSecret([a.name, a.title, a.body, [].concat(a.tags || []).join(" ")].join("\n"));
    if (secret) throw new Error("Not saved: this looks like it contains " + secret + ". Memories are plain text every agent can read, so never put secrets in them. Save where the secret is kept instead (for example \"the deploy key is in 1Password\").");
    const r = store.save(undefined, { name: a.name, title: a.title, body: a.body, tags: a.tags, author: client || "an agent" });
    return (r.created ? "Saved new memory " : "Replaced memory ") + r.memory.name + ".";
  }
  if (name === "memory_delete") {
    if (!store.remove(undefined, a.name, { byName: true })) throw new Error("No memory named " + a.name + ".");
    return "Deleted memory " + store.slug(a.name) + ".";
  }
  throw new Error("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    client = String((params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
    const all = store.list();
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-memory", title: "JMCP Memory", version: VERSION },
      instructions:
        "Shared memory for every agent the user runs, managed in the JMCP app. Search it before work that may depend on the user's preferences or past decisions, and save what a future session should know." +
        (all.length ? "\n\nSaved memories (read one with memory_read):\n" + store.index(all) : "\n\nNo memories are saved yet."),
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  "tools/call"(params) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return { content: [{ type: "text", text: "Invalid arguments: " + wrong }], isError: true };
    try {
      return { content: [{ type: "text", text: call(params.name, params.arguments) }], isError: false };
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods, TOOLS };
