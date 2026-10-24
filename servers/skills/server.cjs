#!/usr/bin/env node
"use strict";

// The JMCP skills library for every agent. Reads ~/.jmcp/skills.db on each
// call, so skills added or turned off in the app reach running agents.

const store = require("./lib/store.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const TOOLS = [
  {
    name: "skills_list",
    description: "List the user's skills with what each is for. Check it at the start of a task, and load any skill whose description matches the work with skill_read. Pass query to search names and descriptions.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional words to look for in skill names and descriptions." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "skill_read",
    description: "Load a skill's full instructions by name. Follow them for the task they describe.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Skill name from skills_list" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "skill_save",
    description: "Create a skill, or replace one you made, when the user asks for a skill or a repeatable way of working worth reusing. Saving with an existing name replaces it, so skill_read it first and keep what still holds. Skills imported from a SKILL.md file are edited in that file instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short kebab-case name, e.g. release-notes" },
        description: { type: "string", description: "When to use it, in one or two sentences. Agents load the skill when a task matches this." },
        instructions: { type: "string", description: "The full instructions in Markdown: steps, rules, examples." },
      },
      required: ["name", "description", "instructions"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
];

function call(name, a) {
  a = a || {};
  if (name === "skills_list") {
    const all = store.active();
    if (!all.length) return "No skills are turned on in JMCP.";
    const words = String(a.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return store.index(all);
    const found = all.filter((s) => words.every((w) => (s.name + " " + s.description).toLowerCase().includes(w)));
    return found.length ? store.index(found) : "No turned-on skill matches " + JSON.stringify(a.query) + ".";
  }
  if (name === "skill_read") {
    const s = store.get(undefined, a.name, { byName: true });
    if (!s || !s.enabled) throw new Error("No skill named " + a.name + " is turned on. Use skills_list.");
    const files = store.supportFiles(s);
    return "# Skill: " + s.name + "\n" + s.description + "\n\n" + s.body +
      (files.length ? "\n\n---\nThis skill's folder has these files. Paths in the instructions are relative to " + require("node:path").dirname(s.origin) + ":\n" + files.map((f) => "- " + f).join("\n") : "");
  }
  if (name === "skill_save") {
    const { skill: s, created } = store.save(undefined, { name: a.name, description: a.description, body: a.instructions });
    if (created) return "Saved new skill " + s.name + ". It is turned on for every agent with jmcp-skills.";
    return "Replaced skill " + s.name + (s.enabled ? "." : ". It is turned off; the user can turn it on in the JMCP app.");
  }
  throw new Error("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    const all = store.active();
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-skills", title: "JMCP Skills", version: VERSION },
      instructions:
        "The user's skills, managed in JMCP. When a task matches a skill's description, load it with skill_read before starting and follow it. When the user asks for a new skill, save it with skill_save." +
        (all.length ? "\n\nSkills:\n" + store.index(all, 60) : "\n\nNo skills are turned on yet."),
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
