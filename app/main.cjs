"use strict";

// JMCP desktop app. The window shows every coding agent's MCP servers and
// installs JMCP servers into them; all file work happens here in the main
// process through core/.
//
// --smoke [--out file.png] [--page id]: load the window hidden, render it,
// save a screenshot and the page text, then quit. No window is shown.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } = require("electron");
const agents = require("../core/agents.cjs");
const catalog = require("../core/catalog.cjs");
const rules = require("../core/rules.cjs");
const memory = require("../core/memory.cjs");
const skills = require("../core/skills.cjs");
const health = require("../core/health.cjs");
const instructions = require("../core/instructions.cjs");
const { activity } = require("../core/activity.cjs");
const { probe } = require("../core/mcp-client.cjs");

const argv = process.argv.slice(1);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : null;
};
const SMOKE = argv.includes("--smoke");
// --home works on a scratch home folder (tests and smoke runs).
const HOME = flag("--home") || process.env.JMCP_TEST_HOME || undefined;

app.setName("JMCP");
if (SMOKE) app.disableHardwareAcceleration();
// --theme dark|light forces a theme (smoke runs check both).
if (flag("--theme")) nativeTheme.themeSource = flag("--theme");

function state() {
  const list = agents.scan(HOME);
  return { home: HOME || require("node:os").homedir(), agents: list, catalog: catalog.catalogState(HOME, list), node: catalog.nodeCommand().command };
}

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

handle("state", () => state());
// force: the user pressed Continue on the "already in" warning.
handle("install", async (id, agentIds, force) => {
  const r = await catalog.installServer(String(id), Array.isArray(agentIds) ? agentIds.map(String) : [], HOME, { force: force === true });
  return Object.assign({ state: state() }, r);
});
handle("install-all", async () => {
  const r = await catalog.installAll(HOME);
  return { servers: r, state: state() };
});
handle("update", async (id) => {
  const r = await catalog.updateServer(String(id), HOME);
  return Object.assign(r, { state: state() });
});
// Updates done when the app started, for the JMCP servers page to show.
let startupUpdates = Promise.resolve([]);
handle("startup-updates", () => startupUpdates);
// Uninstall first, then read the state, so the page sees the server gone.
handle("uninstall", (id, agentIds) => {
  const r = catalog.uninstallServer(String(id), Array.isArray(agentIds) ? agentIds.map(String) : [], HOME);
  return Object.assign({}, r, { state: state() });
});
handle("probe", async (agentId, name) => {
  const a = agents.scan(HOME).find((x) => x.id === agentId);
  const s = a && a.servers.find((x) => x.name === name);
  if (!s) throw new Error("That server is no longer in " + agentId + "'s config.");
  if (s.transport !== "stdio") throw new Error("Remote servers are not checked from JMCP yet.");
  return probe(s, 25000);
});
handle("activity", () => activity(HOME, 100));
handle("rules-list", () => rules.list(HOME));
handle("rules-add", (input) => rules.add(HOME, input));
handle("rules-update", (id, patch) => rules.update(HOME, String(id), patch));
handle("rules-remove", (id) => rules.remove(HOME, String(id)));
handle("rules-preview", () => rules.instructions(rules.active(HOME)));
handle("memory-list", () => memory.list(HOME));
handle("memory-save", (input) => memory.save(HOME, Object.assign({}, input, { author: "JMCP app" })).memory);
handle("memory-update", (id, patch) => memory.update(HOME, String(id), patch));
handle("memory-remove", (id) => memory.remove(HOME, String(id)));
handle("skills-list", () => skills.list(HOME));
handle("skills-add", (input) => skills.add(HOME, Object.assign({}, input, { origin: "" })));
handle("skills-update", (id, patch) => skills.update(HOME, String(id), patch));
handle("skills-remove", (id) => skills.remove(HOME, String(id)));
handle("skills-importable", () => skills.importable(HOME));
// Only files the importable list offered can be imported.
// Health page. Host checks only run for hosts named in ~/.ssh/config.
function knownHost(name) {
  const n = String(name || "");
  if (!health.quick.sshConfig(HOME).hosts.some((x) => x.name === n)) throw new Error(n + " is not a host in ~/.ssh/config.");
  return n;
}
handle("health-local", () => health.quick.localNow());
handle("health-ssh", () => health.quick.sshInventory(HOME));
handle("health-host", (name) => health.quick.checkHost(knownHost(name), HOME));
handle("health-update", (name, opts) => health.quick.applyUpdates(knownHost(name), HOME, { simulate: Boolean(opts && opts.simulate) }));
handle("health-full", (target) => health.fullCheck(target === "local" ? "local" : knownHost(target)));
handle("health-notes", (opts) => health.notes.list(HOME, { dismissed: Boolean(opts && opts.dismissed) }));
handle("health-note-dismiss", (id, back) => health.notes.dismiss(HOME, String(id), back === true));
handle("health-notes-dismiss-all", () => health.notes.dismissAll(HOME));
handle("health-note-remove", (id) => health.notes.remove(HOME, String(id)));
handle("skills-import", (files) => {
  const offered = new Set(skills.importable(HOME).map((x) => x.file));
  return skills.importFiles(HOME, (Array.isArray(files) ? files : []).map(String).filter((f) => offered.has(f)));
});
handle("instructions-list", () => instructions.list(HOME));
handle("instructions-detect", () => instructions.detectFolders(HOME));
handle("instructions-read", (file) => instructions.read(String(file), HOME));
handle("instructions-write", (file, text, expectedHash) => instructions.write(HOME, String(file), String(text), { by: "app", expectedHash: typeof expectedHash === "string" ? expectedHash : undefined }));
handle("instructions-remove", (file) => instructions.remove(HOME, String(file), { by: "app" }));
handle("instructions-add-folder", (folder) => instructions.addFolder(HOME, String(folder)));
handle("instructions-remove-folder", (folder) => instructions.removeFolder(HOME, String(folder)));
handle("instructions-trash", () => instructions.trash(HOME));
handle("instructions-trash-text", (id) => instructions.trashText(HOME, String(id)));
handle("instructions-restore", (id) => instructions.restore(HOME, String(id)));
handle("instructions-forget", (id) => instructions.forget(HOME, String(id)));
handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ["openDirectory"] });
  return r.canceled ? "" : r.filePaths[0] || "";
});
handle("reveal", (file) => {
  const f = String(file || "");
  if (!f) return false;
  if (fs.existsSync(f)) shell.showItemInFolder(f);
  else shell.openPath(path.dirname(f));
  return true;
});

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1280,
    // --height N makes smoke captures taller to see a whole page.
    height: SMOKE && Number(flag("--height")) ? Number(flag("--height")) : 820,
    minWidth: 900,
    minHeight: 560,
    show: !SMOKE,
    title: "JMCP",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: dark ? "#16181d" : "#f5f6f8",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: SMOKE },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: SMOKE && flag("--page") ? { page: flag("--page") } : {} });
  return win;
}

async function smoke(win) {
  const out = path.resolve(flag("--out") || "jmcp-smoke.png");
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  // Wait for the first real render (the renderer sets data-ready).
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const ready = await win.webContents.executeJavaScript("document.documentElement.dataset.ready === '1'");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 600));
  async function settle() {
    const end = Date.now() + 120000;
    while (Date.now() < end && (await win.webContents.executeJavaScript("/Working|Checking|Installing|Loading|Looking for|Reading/.test(document.querySelector('main').innerText)")))
      await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 400));
  }
  // Hidden smoke actions run in order to exercise forms without showing the window.
  await settle();
  for (let i = 0; i < argv.length; i++) {
    const action = argv[i];
    if (!["--smoke-type", "--smoke-set", "--smoke-toggle", "--smoke-click"].includes(action)) continue;
    const entry = argv[++i];
    if (!entry) throw new Error("smoke: missing value for " + action);
    if (action === "--smoke-type" || action === "--smoke-set") {
      const eq = entry.indexOf("=");
      if (eq < 0) throw new Error("smoke: expected " + action + " Label=value");
      const label = entry.slice(0, eq);
      const value = entry.slice(eq + 1);
      const selector = action === "--smoke-set" ? "main select" : "main input, main textarea";
      const event = action === "--smoke-set" ? "change" : "input";
      const found = await win.webContents.executeJavaScript("(() => { const el = [...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((x) => x.getAttribute('aria-label') === " + JSON.stringify(label) + "); if (!el) return false; el.value = " + JSON.stringify(value) + "; el.dispatchEvent(new Event(" + JSON.stringify(event) + ", { bubbles: true })); return true; })()");
      if (!found) throw new Error("smoke: no input " + label);
      if (action === "--smoke-set") await settle();
      continue;
    }
    if (action === "--smoke-toggle") {
      const found = await win.webContents.executeJavaScript("(() => { const el = [...document.querySelectorAll('main input[type=checkbox]')].find((x) => x.getAttribute('aria-label') === " + JSON.stringify(entry) + "); if (el) el.click(); return Boolean(el); })()");
      if (!found) throw new Error("smoke: no checkbox " + entry);
      await settle();
      continue;
    }
    const found = await win.webContents.executeJavaScript("(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.textContent.trim().startsWith(" + JSON.stringify(entry) + ") || x.getAttribute('aria-label') === " + JSON.stringify(entry) + "); if (b) b.click(); return Boolean(b); })()");
    if (!found) throw new Error("smoke: no button " + entry);
    await settle();
  }
  await settle();
  // --scroll N scrolls the page down before the capture.
  if (Number(flag("--scroll"))) await win.webContents.executeJavaScript("document.querySelector('main').scrollTop = " + Number(flag("--scroll")));
  await new Promise((r) => setTimeout(r, 200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  const text = await win.webContents.executeJavaScript("document.querySelector('main').innerText");
  const errors = await win.webContents.executeJavaScript("window.__jmcpErrors || []");
  process.stdout.write(JSON.stringify({ png: out, errors, text: text.slice(0, 4000) }, null, 1) + "\n");
  app.exit(errors.length ? 1 : 0);
}

app.whenReady().then(() => {
  // Bring installed JMCP servers up to this version before the window asks.
  startupUpdates = catalog.updateAll(HOME).catch((e) => [{ ok: false, server: "jmcp", error: String(e.message || e) }]);
  // Each agent file gets, or loses, the master instructions line.
  try {
    instructions.syncPointers(HOME);
  } catch (e) {
    process.stderr.write("master instructions line: " + (e.message || e) + "\n");
  }
  const win = createWindow();
  if (SMOKE) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") process.stderr.write("renderer: " + e.message + "\n");
    });
    smoke(win).catch((e) => {
      process.stderr.write(String(e && e.stack) + "\n");
      app.exit(1);
    });
  }
});
app.on("window-all-closed", () => app.quit());
