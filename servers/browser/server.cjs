#!/usr/bin/env node
"use strict";

// A headless browser for agents. Each browser runs hidden on its own fresh
// profile; ~/.jmcp/browser.db lists the open ones so the JMCP app can show
// them live. When the agent's session ends, its browsers are closed.

const path = require("node:path");
const store = require("./lib/store.js");
const { sweep } = require("./lib/sweep.js");
const { Session } = require("./lib/session.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;
const MAX_OPEN = 4;

const str = (description) => ({ type: "string", description });
const BROWSER = str("Browser name from browser_open, e.g. browser-1. Defaults to the one you used last.");
const TARGET = {
  ref: { type: "integer", description: "Element number from browser_snapshot" },
  selector: str("CSS selector, when there is no ref"),
  text: str("Visible text of a link or button, when there is no ref"),
};
const TOOLS = [
  {
    name: "browser_open",
    description: "Open a new headless browser (Chrome or Edge, hidden, fresh profile with no saved logins) and optionally go to a URL. The user can watch it live on the Browsers page of the JMCP app. Reuse an open browser instead of opening many.",
    inputSchema: { type: "object", properties: { url: str("Page to open, e.g. https://example.com") }, additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "Go to a URL in a browser and wait for it to load.",
    inputSchema: { type: "object", properties: { url: str("Page to open"), browser: BROWSER }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description: "Read the page: its title, URL, numbered list of links, buttons and fields (use the numbers as ref in browser_click and browser_type), and its visible text. Read again after the page changes; refs only hold until then.",
    inputSchema: { type: "object", properties: { browser: BROWSER, max_text: { type: "integer", description: "Most characters of page text (default 8000)" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_click",
    description: "Click an element with the mouse, by ref, selector or visible text. Waits for any page load it starts.",
    inputSchema: { type: "object", properties: Object.assign({ browser: BROWSER }, TARGET), additionalProperties: false },
  },
  {
    name: "browser_type",
    description: "Click a field and type into it, replacing what is there unless append is true. submit presses Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: Object.assign({ browser: BROWSER, value: str("Text to type") }, TARGET, { submit: { type: "boolean", description: "Press Enter after typing" }, append: { type: "boolean", description: "Keep what is in the field" } }),
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "Press a key on the focused element: Enter, Tab, Escape, Backspace, Delete, arrow keys, Home, End, PageUp, PageDown, Space, or one character.",
    inputSchema: { type: "object", properties: { key: str("Key name"), browser: BROWSER }, required: ["key"], additionalProperties: false },
  },
  {
    name: "browser_back",
    description: "Go back one page in the browser's history.",
    inputSchema: { type: "object", properties: { browser: BROWSER }, additionalProperties: false },
  },
  {
    name: "browser_screenshot",
    description: "Take a PNG screenshot of the page as it looks now.",
    inputSchema: { type: "object", properties: { browser: BROWSER, full_page: { type: "boolean", description: "The whole page, not only what fits in the window" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_eval",
    description: "Run JavaScript in the page and get the result back as JSON. Promises are awaited.",
    inputSchema: { type: "object", properties: { expression: str("JavaScript expression, e.g. document.querySelectorAll('li').length"), browser: BROWSER }, required: ["expression"], additionalProperties: false },
  },
  {
    name: "browser_handoff",
    description: "Hand the browser to the user when a person has to act: a CAPTCHA, a login, a 2FA code, a payment, or anything you cannot or should not do. The user gets a notice in the JMCP app, takes control of the live page there, and hands it back. This waits until they do (or until timeout_sec), then tells you where the page is.",
    inputSchema: {
      type: "object",
      properties: { reason: str("What the user should do, e.g. Solve the CAPTCHA, then hand it back"), browser: BROWSER, timeout_sec: { type: "integer", description: "Most seconds to wait (default 600, at most 900)" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_list",
    description: "List the browsers you have open and the page each is on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "browser_close",
    description: "Close a browser when you are done with it. Its profile is deleted.",
    inputSchema: { type: "object", properties: { browser: BROWSER }, additionalProperties: false },
    annotations: { destructiveHint: true },
  },
];

let client = "";
let counter = 0;
let last = "";
const sessions = new Map(); // name -> Session

// The named browser, or the one used last. A browser the user closed from
// the JMCP app (or that quit) is dropped here too.
function pick(name) {
  const key = name || last;
  if (!key) throw new Error("No browser is open. Start one with browser_open.");
  const s = sessions.get(key);
  if (!s) throw new Error("No open browser named " + key + ". Open ones: " + ([...sessions.keys()].join(", ") || "none") + ".");
  const row = store.byId(undefined, s.row.id);
  if (!row || row.status !== "open" || s.gone || !store.alive(s.pid)) {
    sessions.delete(key);
    if (last === key) last = "";
    s.close(row && row.closed_reason ? row.closed_reason : "The browser quit.").catch(() => {});
    throw new Error("Browser " + key + " was closed" + (row && row.closed_reason ? ": " + row.closed_reason : ".") + " Open a new one with browser_open.");
  }
  last = key;
  return s;
}

const text = (t) => ({ content: [{ type: "text", text: t }], isError: false });

async function call(name, a) {
  if (name === "browser_open") {
    if (sessions.size >= MAX_OPEN) throw new Error("You already have " + sessions.size + " browsers open (" + [...sessions.keys()].join(", ") + "). Reuse one or close one with browser_close.");
    const bname = "browser-" + ++counter;
    const s = await Session.open({ name: bname, agent: client || "an agent", cwd: process.cwd() });
    sessions.set(bname, s);
    last = bname;
    const opened = "Opened " + bname + " (headless " + path.basename(s.program, path.extname(s.program)) + "). The user can watch it on the JMCP Browsers page.";
    if (!a.url) {
      await s.where("Opened the browser");
      return text(opened);
    }
    return text(opened + "\n" + (await s.navigate(a.url)));
  }
  if (name === "browser_list") {
    if (!sessions.size) return text("No browsers are open.");
    const rows = [];
    for (const [n, s] of sessions) {
      const row = store.byId(undefined, s.row.id) || {};
      rows.push("- " + n + (n === last ? " (last used)" : "") + ": " + (row.status === "open" ? (row.title || "(no title)") + " | " + (row.url || "about:blank") : "closed" + (row.closed_reason ? ": " + row.closed_reason : "")));
    }
    return text(rows.join("\n"));
  }
  if (name === "browser_close") {
    const s = pick(a.browser);
    sessions.delete(s.name);
    if (last === s.name) last = sessions.size ? [...sessions.keys()].pop() : "";
    await s.close("Closed by the agent.");
    return text("Closed " + s.name + ".");
  }
  const s = pick(a.browser);
  if (name === "browser_handoff") {
    if (!a.reason.trim()) throw new Error("reason must say what the user should do.");
    return text(await s.handoff(a.reason.trim(), Math.max(10, Math.min(900, Number.isInteger(a.timeout_sec) ? a.timeout_sec : 600))));
  }
  // While the user drives the browser in the JMCP app, only reading is allowed.
  const row = store.byId(undefined, s.row.id);
  if (row && row.control === "user" && !["browser_snapshot", "browser_screenshot"].includes(name)) {
    throw new Error("The user has taken control of " + s.name + " in the JMCP app. Call browser_handoff with what you are waiting for, to wait until they hand it back.");
  }
  const target = () => {
    const given = ["ref", "selector", "text"].filter((k) => a[k] !== undefined && a[k] !== "");
    if (given.length !== 1) throw new Error("Give exactly one of ref, selector or text.");
    return { [given[0]]: a[given[0]] };
  };
  if (name === "browser_navigate") return text(await s.navigate(a.url));
  if (name === "browser_snapshot") return text(await s.snapshot(a.max_text));
  if (name === "browser_click") return text(await s.click(target()));
  if (name === "browser_type") return text(await s.type(target(), a.value, { submit: a.submit === true, append: a.append === true }));
  if (name === "browser_press") return text(await s.press(a.key));
  if (name === "browser_back") return text(await s.back());
  if (name === "browser_eval") return text(await s.evaluate(a.expression));
  if (name === "browser_screenshot") {
    const data = await s.screenshot(a.full_page === true);
    return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: "Screenshot of " + s.name + ": " + (s.row.title || "(no title)") + " | " + s.row.url }], isError: false };
  }
  throw new Error("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    client = String((params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jmcp-browser", title: "JMCP Browser", version: VERSION },
      instructions:
        "A headless browser for web tasks: open a page with browser_open, read it with browser_snapshot, then click and type by the ref numbers it lists. Each browser starts with a fresh profile and no saved logins. The user can watch your browsers live on the JMCP Browsers page. If you hit a CAPTCHA, a login or anything a person must do, call browser_handoff: the user takes control in the JMCP app and hands it back. Close a browser with browser_close when you are done.",
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  async "tools/call"(params) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return { content: [{ type: "text", text: "Invalid arguments: " + wrong }], isError: true };
    try {
      return await call(params.name, params.arguments || {});
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

async function shutdown() {
  await Promise.allSettled([...sessions.values()].map((s) => s.close("The agent's session ended.")));
  sessions.clear();
}

if (require.main === module) {
  sweep().catch(() => {});
  serve(methods, () => {
    shutdown().finally(() => process.exit(0));
  });
}

module.exports = { methods, TOOLS, shutdown };
