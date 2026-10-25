"use strict";

// The Browsers page: the headless browsers agents have open through
// jmcp-browser, a live screenshot of each, closing one, and taking control
// of one (clicks, keys and scrolling sent to the page) to hand it back later.

const store = require("../servers/browser/lib/store.js");
const cdp = require("../servers/browser/lib/cdp.js");
const { KEYS } = require("../servers/browser/lib/session.js");
const { sweep, closeRow } = require("../servers/browser/lib/sweep.js");

const view = (r) => ({ id: r.id, name: r.name, agent: r.agent, cwd: r.cwd, status: r.status, url: r.url, title: r.title, lastAction: r.last_action, closedReason: r.closed_reason, program: r.program, startedAt: r.started_at, updatedAt: r.updated_at, closedAt: r.closed_at, control: r.control || "", askReason: r.ask_reason || "", askAt: r.ask_at || null });

async function list(home) {
  await sweep(home);
  return { open: store.open(home).map(view), recent: store.recent(home, 10).map(view) };
}

function openRow(home, id) {
  const row = store.byId(home, String(id));
  if (!row || row.status !== "open") throw new Error("That browser is closed.");
  return row;
}

// The page the agent is on: the tab it last attached to, else the last one.
async function pageTarget(row) {
  if (!(await cdp.sameBrowser(row.port, row.browser_ws))) throw new Error("That browser is not answering.");
  const pages = await cdp.pages(row.port);
  const target = pages.find((t) => t.id === row.target_id) || pages.find((t) => t.url === row.url) || pages[pages.length - 1];
  if (!target) throw new Error("That browser has no page open.");
  return target;
}

async function withPage(row, fn) {
  const c = await cdp.connect((await pageTarget(row)).webSocketDebuggerUrl, 5000);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

// A JPEG of the page and the page's size in CSS pixels, so the app can map
// a click on the picture to the page.
async function screenshot(home, id) {
  return withPage(openRow(home, id), async (c) => {
    const m = await c.send("Page.getLayoutMetrics", {}, 5000);
    const vp = m.cssVisualViewport || m.visualViewport || {};
    const r = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, 10000);
    return { src: "data:image/jpeg;base64," + r.data, width: Math.round(vp.clientWidth || 1280), height: Math.round(vp.clientHeight || 800) };
  });
}

async function close(home, id) {
  await closeRow(home, openRow(home, id), "Closed from the JMCP app.");
  return true;
}

function takeControl(home, id) {
  openRow(home, id);
  return store.takeControl(home, String(id));
}

function handBack(home, id, note) {
  openRow(home, id);
  return store.handBack(home, String(id), note);
}

const num = (v, name) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(name + " must be a number.");
  return v;
};
const BUTTONS = ["left", "middle", "right"];

// One input from the app's control view. Only while the user has control,
// so a stray click on a live view never reaches an agent's page.
async function input(home, id, ev) {
  const row = openRow(home, id);
  if (row.control !== "user") throw new Error("Take control of this browser first.");
  if (!ev || typeof ev !== "object") throw new Error("No input given.");
  return withPage(row, async (c) => {
    const mouse = (type, extra) => c.send("Input.dispatchMouseEvent", Object.assign({ type, x: num(ev.x, "x"), y: num(ev.y, "y") }, extra), 5000);
    const button = BUTTONS.includes(ev.button) ? ev.button : "left";
    if (ev.type === "down") await mouse("mousePressed", { button, clickCount: 1 });
    else if (ev.type === "up") await mouse("mouseReleased", { button, clickCount: 1 });
    else if (ev.type === "move") await mouse("mouseMoved", { button: ev.pressed ? button : "none", buttons: ev.pressed ? 1 : 0 });
    else if (ev.type === "wheel") await mouse("mouseWheel", { deltaX: num(ev.dx || 0, "dx"), deltaY: num(ev.dy || 0, "dy") });
    else if (ev.type === "text") {
      if (typeof ev.text !== "string" || !ev.text) throw new Error("text must not be empty.");
      await c.send("Input.insertText", { text: ev.text.slice(0, 10000) }, 5000);
    } else if (ev.type === "key") {
      const k = KEYS[ev.key];
      if (!k) throw new Error("Unknown key " + ev.key + ".");
      const mods = (ev.ctrl ? 2 : 0) | (ev.shift ? 8 : 0) | (ev.alt ? 1 : 0);
      const base = { key: k.key || ev.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mods };
      await c.send("Input.dispatchKeyEvent", Object.assign({ type: k.text ? "keyDown" : "rawKeyDown", text: k.text }, base), 5000);
      await c.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base), 5000);
    } else throw new Error("Unknown input " + ev.type + ".");
    return true;
  });
}

module.exports = { list, screenshot, close, takeControl, handBack, input };
