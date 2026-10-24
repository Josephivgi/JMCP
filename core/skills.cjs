"use strict";

// The skills library, plus the agents' own skill folders JMCP can import from.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../servers/skills/lib/store.js");

const SOURCES = [
  ["Claude Code", ".claude/skills"],
  ["Codex", ".codex/skills"],
  ["Factory Droid", ".factory/skills"],
  ["Cursor", ".cursor/skills"],
  ["Gemini CLI", ".gemini/skills"],
  ["OpenCode", ".config/opencode/skills"],
  ["Grok", ".grok/skills"],
  ["Shared (.agents)", ".agents/skills"],
];

// Every SKILL.md in the agents' skill folders, and whether it is in the library.
function importable(home) {
  const base = home || os.homedir();
  const lib = store.list(home);
  const out = [];
  for (const [agent, rel] of SOURCES) {
    const root = path.join(base, ...rel.split("/"));
    if (!fs.existsSync(root)) continue;
    for (const file of store.findSkillFiles([root])) {
      try {
        const s = store.readSkillFile(file);
        const have = lib.find((x) => x.name === s.name);
        out.push({ agent, root, file, name: s.name, description: s.description, state: !have ? "new" : have.origin === file ? "imported" : "taken" });
      } catch (e) {
        out.push({ agent, root, file, name: path.basename(path.dirname(file)), description: "", state: "error", error: String(e.message || e) });
      }
    }
  }
  return out;
}

module.exports = Object.assign({}, store, { SOURCES, importable });
