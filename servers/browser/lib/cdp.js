"use strict";

// Headless Chrome or Edge, driven over the DevTools protocol. No packages:
// Node's own WebSocket and fetch talk to the browser's debugging port, which
// only listens on 127.0.0.1.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// JMCP_BROWSER first, then Chrome, then Edge (every Windows has Edge).
function findBrowsers() {
  const list = [];
  if (process.env.JMCP_BROWSER) list.push(process.env.JMCP_BROWSER);
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) list.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
    for (const r of roots) list.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
    for (const r of roots) list.push(path.join(r, "Chromium", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) list.push(path.join(dir, n));
    }
  }
  return [...new Set(list.filter(isFile))];
}

function findBrowser() {
  return findBrowsers()[0] || "";
}

function isFile(f) {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start a headless browser on its own profile and wait for its DevTools port.
async function launch(program, profile, opts) {
  const o = opts || {};
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "--window-size=" + (o.width || 1280) + "," + (o.height || 800),
    "about:blank",
  ];
  // On Windows the started process often hands over to another one and
  // exits with code 0, so the browser is found by its DevTools port and its
  // real pid asked for over DevTools.
  const child = spawn(program, args, { windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
  let failed = null;
  child.once("error", (e) => (failed = e));
  child.once("exit", (code) => {
    if (code) failed = failed || new Error("The browser quit at start (exit code " + code + ").");
  });
  const file = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + (o.timeoutMs || 30000);
  while (Date.now() < until) {
    if (failed) throw failed;
    let found = null;
    try {
      const [port, wsPath] = fs.readFileSync(file, "utf8").split(/\r?\n/);
      if (Number(port) > 0 && wsPath) found = { port: Number(port), browserWs: "ws://127.0.0.1:" + Number(port) + wsPath };
    } catch {
      /* not written yet */
    }
    if (found) {
      found.pid = (await browserPid(found.browserWs)) || (child.exitCode == null ? child.pid : 0);
      if (!found.pid) {
        await closeBrowser(found.browserWs);
        throw new Error("Could not find the browser's process.");
      }
      return found;
    }
    await sleep(100);
  }
  if (child.exitCode == null) await killPid(child.pid);
  throw new Error("The browser did not open its DevTools port within " + Math.round((o.timeoutMs || 30000) / 1000) + " seconds.");
}

async function browserPid(browserWs) {
  try {
    const c = await connect(browserWs, 5000);
    try {
      const r = await c.send("SystemInfo.getProcessInfo", {}, 5000);
      const p = (r.processInfo || []).find((x) => x.type === "browser");
      return p ? Number(p.id) : 0;
    } finally {
      c.close();
    }
  } catch {
    return 0;
  }
}

async function json(port, p, timeoutMs) {
  const r = await fetch("http://127.0.0.1:" + port + p, { signal: AbortSignal.timeout(timeoutMs || 5000) });
  if (!r.ok) throw new Error("DevTools " + p + ": HTTP " + r.status);
  return r.json();
}

// Page targets of a browser, the way the debugging port lists them.
async function pages(port) {
  return (await json(port, "/json/list")).filter((t) => t.type === "page");
}

// True when the port is still the browser this row started: the id in its
// WebSocket path matches. A reused port belongs to something else.
async function sameBrowser(port, browserWs) {
  if (!port || !browserWs) return false;
  try {
    const v = await json(port, "/json/version", 2000);
    return v.webSocketDebuggerUrl && new URL(v.webSocketDebuggerUrl).pathname === new URL(browserWs).pathname;
  } catch {
    return false;
  }
}

// One DevTools WebSocket: send(method, params) resolves with the result;
// on(event, fn) listens for events.
function connect(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    let closed = null;
    const timer = setTimeout(() => {
      reject(new Error("Could not connect to the browser in time."));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, timeoutMs || 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to the browser."));
    });
    ws.addEventListener("close", () => {
      closed = new Error("The browser connection closed.");
      for (const p of pending.values()) p.reject(closed);
      pending.clear();
      for (const fn of listeners.get("close") || []) fn();
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "DevTools error"));
        else p.resolve(msg.result || {});
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params || {});
      }
    });
    const client = {
      send(method, params, ms) {
        if (closed) return Promise.reject(closed);
        const id = nextId++;
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            pending.delete(id);
            rej(new Error(method + " took longer than " + Math.round((ms || 30000) / 1000) + " seconds."));
          }, ms || 30000);
          pending.set(id, { resolve: res, reject: rej, timer: t });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event).delete(fn);
      },
      get closed() {
        return Boolean(closed);
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
  });
}

// Ask the browser to quit over DevTools; true when it took the request.
async function closeBrowser(browserWs) {
  try {
    const c = await connect(browserWs, 3000);
    await c.send("Browser.close", {}, 3000).catch(() => {});
    c.close();
    return true;
  } catch {
    return false;
  }
}

// A browser and every process it started (taskkill /T on Windows). Only
// call it for a pid DevTools named as the browser.
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const t = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      t.on("error", () => resolve());
      t.on("close", () => resolve());
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  return Promise.resolve();
}

// A profile folder can stay locked for a moment after the browser quits.
async function removeProfile(profile) {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(300);
    }
  }
  return !fs.existsSync(profile);
}

module.exports = { findBrowsers, findBrowser, launch, pages, sameBrowser, connect, closeBrowser, killPid, removeProfile, sleep };
