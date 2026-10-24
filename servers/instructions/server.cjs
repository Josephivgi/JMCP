#!/usr/bin/env node
"use strict";

// Gives every agent the user's master instructions, and lets agents list,
// read, write and delete instruction files (AGENTS.md, CLAUDE.md, GEMINI.md,
// QWEN.md). Deletes and overwrites keep a copy the JMCP app can restore.
// The master text is read on each request so edits reach running agents.

const store = require("./lib/store.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;
const NAMES = store.NAMES.join(", ");

const pathProp = { type: "string", description: "Absolute path to the file. The name must be one of " + NAMES + ", or it must be a .md file directly in ~/.claude/rules (Claude Code rules)." };

// Server instructions stay short enough for every agent to take them; the
// master_instructions tool always returns the whole text.
const INLINE_MAX = 32 * 1024;

const TOOLS = [
  {
    name: "master_instructions",
    description: "The user's MASTER INSTRUCTIONS. You must call this tool before your first reply in every session, and again at the start of each new task, then follow what it returns in everything you do. It is read-only and fast. Some agents never show server instructions, so this tool is how they reach you.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list",
    description: "List instruction files: each agent's global file (made or not), Claude Code rules in ~/.claude/rules, project folders saved in JMCP and other folders found with instruction files. Pass folder to also list the files in that folder, such as your working folder.",
    inputSchema: { type: "object", properties: { folder: { type: "string", description: "Absolute folder to also look in." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read",
    description: "Read an instruction file. Returns its text and a hash to pass to write.",
    inputSchema: { type: "object", properties: { path: pathProp }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write",
    description: "Create or replace an instruction file with the full new content. Read it first and pass its hash so changes made since are not lost. The old version is kept and can be restored in the JMCP app.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp, content: { type: "string", description: "The whole new file." }, hash: { type: "string", description: "Hash from read. Required to replace a file that exists. Leave it out or empty only for a new file." } },
      required: ["path", "content"],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: "delete",
    description: "Delete an instruction file. Only do this when the user asked. The file is moved to the JMCP trash and can be restored in the JMCP app.",
    inputSchema: { type: "object", properties: { path: pathProp }, required: ["path"] },
    annotations: { destructiveHint: true },
  },
];

function size(n) {
  return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
}

function listText(r, detected) {
  const lines = ["Master instructions (set by the user in the JMCP app, read-only for agents): " + r.master.path + (r.master.exists ? " (" + size(r.master.size) + ")" : " (not set)"), "", "Agent instruction files:"];
  for (const f of r.agents) lines.push("- " + f.agent + ": " + f.path + (f.exists ? " (" + size(f.size) + ")" : " (not made yet)"));
  lines.push("", "Claude Code rules (every .md file in " + store.rulesDir() + " is read by Claude Code):");
  if (r.rules.length) for (const f of r.rules) lines.push("- " + f.path + " (" + size(f.size) + ")");
  else lines.push("- none yet");
  if (detected.length) {
    lines.push("", "Other folders with instruction files (found, not saved in JMCP):");
    for (const d of detected) for (const f of d.files) lines.push("- " + f.path + " (" + size(f.size) + ")");
  }
  if (r.folders.length) {
    lines.push("", "Project folders:");
    for (const d of r.folders) {
      lines.push("- " + d.path + (d.saved ? "" : " (not saved in JMCP)") + (d.exists ? "" : " (folder missing)"));
      for (const f of d.files) lines.push("  - " + f.path + " (" + size(f.size) + ")");
      if (d.exists && !d.files.length) lines.push("  - no instruction files");
    }
  }
  return lines.join("\n");
}

// The master instructions, labeled so the agent knows it must follow them.
function masterBlock(text, max) {
  const cut = Boolean(max) && Buffer.byteLength(text) > max;
  // Cutting by bytes can split a character; drop the broken end.
  const body = cut ? Buffer.from(text).subarray(0, max).toString("utf8").replace(/�+$/, "") : text;
  return [
    "MASTER INSTRUCTIONS",
    "The user set these master instructions in JMCP. You must follow them in every task. They come before other instruction files, rules and memories when they conflict.",
    "",
    body,
    cut ? "\n(Cut here. Call the master_instructions tool for the rest.)" : null,
    "END OF MASTER INSTRUCTIONS",
  ].filter((l) => l !== null).join("\n");
}

function call(name, a) {
  a = a || {};
  if (name === "master_instructions") {
    const text = store.master();
    return text ? masterBlock(text) : "The user has not set master instructions yet.";
  }
  if (name === "list") {
    const r = store.list(undefined, a.folder || undefined);
    const shown = r.folders.map((d) => d.path);
    const same = (x, y) => (process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y);
    const detected = store.detectFolders().filter((d) => !shown.some((p) => same(p, d.path))).slice(0, 40);
    return listText(r, detected);
  }
  if (name === "read") {
    const r = store.read(a.path);
    return "Path: " + r.path + "\nHash: " + r.hash + "\n\n" + r.text;
  }
  if (name === "write") {
    // A write with no hash may only create a file, never replace one.
    const r = store.write(undefined, a.path, a.content, { by: "agent", expectedHash: typeof a.hash === "string" ? a.hash.trim() : "" });
    if (!r.changed) return "No change: " + r.path + " already has that content.";
    return (r.created ? "Created " : "Saved ") + r.path + ". New hash: " + r.hash + (r.created ? "" : ". The old version can be restored in the JMCP app.");
  }
  if (name === "delete") {
    const r = store.remove(undefined, a.path, { by: "agent" });
    return "Deleted " + r.path + ". It is in the JMCP trash and can be restored from the JMCP app.";
  }
  throw new Error("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    const text = store.master();
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-instructions", title: "JMCP Instructions", version: VERSION },
      instructions: (text ? masterBlock(text, INLINE_MAX) + "\n\n" : "") + "Use these tools when the user asks to see, change, create or remove agent instruction files (" + NAMES + ", and Claude Code rules in ~/.claude/rules), for one agent or a project. Read a file before writing it and pass its hash. Delete only when the user asks; deleted and replaced files can be restored in the JMCP app.",
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
