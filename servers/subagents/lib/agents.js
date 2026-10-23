"use strict";

// Agents the subagents server can start, ported from JAgents' lib/agents.js.
// Most speak ACP over stdio; Claude Code runs natively through the Claude
// Agent SDK. Commands are resolved the same way JAgents does it: npm .cmd
// shims unwrapped, .ps1 shims skipped, Cursor's versioned node.exe used
// directly so no PowerShell window starts.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProgram, isFile } = require("./win-command");

const HOME = os.homedir();
const LOCAL_BIN = path.join(HOME, ".local", "bin");

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
}

function npmGlobalDir() {
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  return "/usr/local/bin";
}

const RESOLVE_CACHE_MS = 15000;
const resolveCache = new Map();

function findProgram(names, extraDirs) {
  const key = JSON.stringify([names, extraDirs]);
  const hit = resolveCache.get(key);
  if (hit && hit.at > Date.now() - RESOLVE_CACHE_MS) return hit.value;
  const value = findProgramUncached(names, extraDirs);
  resolveCache.set(key, { at: Date.now(), value });
  return value;
}

function findProgramUncached(names, extraDirs) {
  const list = Array.isArray(names) ? names : [names];
  const dirs = [npmGlobalDir()].concat(extraDirs || []).filter(Boolean);
  for (const name of list) {
    const raw = String(name || "").trim();
    if (!raw) continue;
    if (path.isAbsolute(raw)) {
      if (isFile(raw) && !/\.ps1$/i.test(raw)) return raw;
      continue;
    }
    const onPath = resolveProgram(raw);
    if (onPath && onPath !== raw) return onPath;
    for (const dir of dirs) {
      for (const candidate of process.platform === "win32" ? [raw + ".cmd", raw + ".exe", raw] : [raw]) {
        const file = path.join(dir, candidate);
        if (isFile(file) && !/\.ps1$/i.test(file)) return file;
      }
    }
  }
  return null;
}

function programSpec(names, args, extraDirs, env) {
  const command = findProgram(names, [LOCAL_BIN].concat(extraDirs || []));
  return command ? { command, args: (args || []).slice(), env: env || {} } : null;
}

function versionKey(name) {
  return (String(name).match(/\d+/g) || []).slice(0, 6).map((d) => d.padStart(4, "0")).join("");
}

function cursorAgentSpec(args) {
  const root = path.join(localAppData(), "cursor-agent", "versions");
  try {
    const versions = fs
      .readdirSync(root)
      .filter((v) => isFile(path.join(root, v, "node.exe")) && isFile(path.join(root, v, "index.js")))
      .sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    if (versions.length) {
      const dir = path.join(root, versions[0]);
      return { command: path.join(dir, "node.exe"), args: [path.join(dir, "index.js")].concat(args), env: { CURSOR_INVOKED_AS: "cursor-agent" } };
    }
  } catch {
    /* fall through to PATH */
  }
  return programSpec("cursor-agent", args);
}

function devinSpec() {
  const bundled = path.join(localAppData(), "devin", "cli", "bin", process.platform === "win32" ? "devin.exe" : "devin");
  if (isFile(bundled)) return { command: bundled, args: ["acp"], env: {} };
  return programSpec("devin", ["acp"]);
}

// The installed claude CLI (same sign-in as the terminal) through the Agent
// SDK; without it, the SDK's bundled binary when that package is present.
function claudeNativeSpec() {
  const cli = programSpec("claude", [], [LOCAL_BIN]);
  if (cli && /\.(exe|js|mjs|cjs)$/i.test(cli.command)) return cli;
  try {
    require.resolve("@anthropic-ai/claude-agent-sdk-" + process.platform + "-" + process.arch + "/package.json");
    return { command: "", args: [], env: {} };
  } catch {
    return cli;
  }
}

// npx run as node + npx-cli.js: npx.cmd is not an npm shim, and running it
// through cmd breaks on the space in "Program Files".
function npxSpec(pkgArgs) {
  const node = findProgram("node");
  if (!node) return null;
  const cli = path.join(path.dirname(node), "node_modules", "npm", "bin", "npx-cli.js");
  if (isFile(cli)) return { command: node, args: [cli].concat(pkgArgs), env: {} };
  return process.platform === "win32" ? null : programSpec("npx", pkgArgs);
}

const NO_UPDATE = { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" };

const AGENTS = [
  {
    id: "claude-code",
    aliases: ["claude"],
    name: "Claude Code",
    native: "claude-sdk",
    resolve: claudeNativeSpec,
    install: "Install Claude Code: irm https://claude.ai/install.ps1 | iex",
  },
  {
    id: "codex",
    aliases: ["codex-acp"],
    name: "Codex",
    // The codex CLI has no ACP mode of its own; with only codex installed,
    // run the official adapter through npx (it uses the codex sign-in).
    resolve: () => programSpec("codex-acp", [], [path.join(HOME, ".cargo", "bin")]) || (findProgram("codex") ? npxSpec(["-y", "@agentclientprotocol/codex-acp@2.2.2"]) : null),
    install: "npm install -g @agentclientprotocol/codex-acp",
  },
  {
    id: "factory-droid",
    aliases: ["droid", "factory"],
    name: "Factory Droid",
    resolve: () => programSpec("droid", ["exec", "--output-format", "acp-daemon"], [path.join(HOME, "bin")], NO_UPDATE),
    install: "Install Factory Droid: irm https://app.factory.ai/cli/windows | iex",
  },
  { id: "devin", name: "Devin", resolve: devinSpec, install: "Install the Devin CLI, then run devin auth login." },
  { id: "cursor", name: "Cursor", resolve: () => cursorAgentSpec(["acp"]), install: "Install the Cursor CLI, then run cursor-agent login." },
  { id: "opencode", name: "OpenCode", resolve: () => programSpec("opencode", ["acp"]), install: "npm install -g opencode-ai" },
  { id: "gemini", aliases: ["gemini-cli"], name: "Gemini CLI", resolve: () => programSpec("gemini", ["--acp"]), install: "npm install -g @google/gemini-cli" },
  { id: "qwen", aliases: ["qwen-code"], name: "Qwen Code", resolve: () => programSpec("qwen", ["--acp"]), install: "npm install -g @qwen-code/qwen-code" },
  { id: "grok", aliases: ["grok-build"], name: "Grok", resolve: () => programSpec("grok", ["agent", "stdio"], [path.join(HOME, ".grok", "bin")]), install: "Install the Grok CLI." },
  { id: "copilot", aliases: ["github-copilot"], name: "GitHub Copilot CLI", resolve: () => programSpec("copilot", ["--acp", "--stdio"]), install: "npm install -g @github/copilot" },
  { id: "kilo", name: "Kilo", resolve: () => programSpec("kilo", ["acp"]), install: "npm install -g @kilocode/cli" },
  { id: "goose", name: "goose", resolve: () => programSpec("goose", ["acp"]), install: "Install goose from github.com/block/goose." },
  { id: "cline", name: "Cline", resolve: () => programSpec("cline", ["--acp"]), install: "npm install -g cline" },
  { id: "kimi", name: "Kimi CLI", resolve: () => programSpec("kimi", ["acp"]), install: "uv tool install kimi-cli" },
];

function safeResolve(item) {
  try {
    return item.resolve() || null;
  } catch {
    return null;
  }
}

function agent(id) {
  const key = String(id || "").trim().toLowerCase();
  return AGENTS.find((a) => a.id === key) || AGENTS.find((a) => (a.aliases || []).includes(key)) || null;
}

function listAgents() {
  return AGENTS.map((a) => {
    const spec = safeResolve(a);
    return { id: a.id, aliases: a.aliases || [], name: a.name, native: a.native || "", installed: Boolean(spec), command: spec ? spec.command : "", install: spec ? "" : a.install };
  });
}

function spawnSpec(id) {
  const a = agent(id);
  if (!a) throw new Error("Unknown provider " + id + ".");
  const spec = safeResolve(a);
  if (!spec) throw new Error(a.name + " is not installed. " + a.install);
  return spec;
}

module.exports = { AGENTS, agent, listAgents, spawnSpec, findProgram };
