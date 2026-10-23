"use strict";

// JMCP desktop app. The window shows every coding agent's MCP servers and
// installs JMCP servers into them; all file work happens here in the main
// process through core/.
//
// --smoke [--out file.png] [--page id]: load the window hidden, render it,
// save a screenshot and the page text, then quit. No window is shown.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require("electron");
const agents = require("../core/agents.cjs");
const catalog = require("../core/catalog.cjs");
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
handle("install", async (id, agentIds) => {
  const r = await catalog.installServer(String(id), Array.isArray(agentIds) ? agentIds.map(String) : [], HOME);
  return Object.assign({ state: state() }, r);
});
handle("update", async (id) => {
  const r = await catalog.updateServer(String(id), HOME);
  return Object.assign(r, { state: state() });
});
// Updates done when the app started, for the JMCP servers page to show.
let startupUpdates = Promise.resolve([]);
handle("startup-updates", () => startupUpdates);
handle("uninstall", (id, agentIds) => Object.assign({ state: state() }, catalog.uninstallServer(String(id), Array.isArray(agentIds) ? agentIds.map(String) : [], HOME)));
handle("probe", async (agentId, name) => {
  const a = agents.scan(HOME).find((x) => x.id === agentId);
  const s = a && a.servers.find((x) => x.name === name);
  if (!s) throw new Error("That server is no longer in " + agentId + "'s config.");
  if (s.transport !== "stdio") throw new Error("Remote servers are not checked from JMCP yet.");
  return probe(s, 25000);
});
handle("activity", () => activity(HOME, 100));
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
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: !SMOKE,
    title: "JMCP",
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
  // --smoke-click "Button text": press that button and wait for the page to settle.
  const click = flag("--smoke-click");
  if (click) {
    const found = await win.webContents.executeJavaScript("(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.textContent.trim().startsWith(" + JSON.stringify(click) + ")); if (b) b.click(); return Boolean(b); })()");
    if (!found) process.stderr.write("smoke: no button " + click + "\n");
    const end = Date.now() + 120000;
    while (Date.now() < end && (await win.webContents.executeJavaScript("/Working|Checking/.test(document.body.innerText)"))) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 400));
  }
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
