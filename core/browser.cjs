"use strict";

// The Browsers page: the headless browsers agents have open through
// jmcp-browser, a live screenshot of each, and closing one.

const store = require("../servers/browser/lib/store.js");
const cdp = require("../servers/browser/lib/cdp.js");
const { sweep, closeRow } = require("../servers/browser/lib/sweep.js");

const view = (r) => ({ id: r.id, name: r.name, agent: r.agent, cwd: r.cwd, status: r.status, url: r.url, title: r.title, lastAction: r.last_action, closedReason: r.closed_reason, program: r.program, startedAt: r.started_at, updatedAt: r.updated_at, closedAt: r.closed_at });

async function list(home) {
  await sweep(home);
  return { open: store.open(home).map(view), recent: store.recent(home, 10).map(view) };
}

function openRow(home, id) {
  const row = store.byId(home, String(id));
  if (!row || row.status !== "open") throw new Error("That browser is closed.");
  return row;
}

// A JPEG of the page the agent is on, as a data URL for an <img>.
async function screenshot(home, id) {
  const row = openRow(home, id);
  if (!(await cdp.sameBrowser(row.port, row.browser_ws))) throw new Error("That browser is not answering.");
  const pages = await cdp.pages(row.port);
  const target = pages.find((t) => t.url === row.url) || pages[pages.length - 1];
  if (!target) throw new Error("That browser has no page open.");
  const c = await cdp.connect(target.webSocketDebuggerUrl, 5000);
  try {
    const r = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, 10000);
    return "data:image/jpeg;base64," + r.data;
  } finally {
    c.close();
  }
}

async function close(home, id) {
  await closeRow(home, openRow(home, id), "Closed from the JMCP app.");
  return true;
}

module.exports = { list, screenshot, close };
