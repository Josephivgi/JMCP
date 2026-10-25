"use strict";

// One headless browser an agent drives: its process, the page it is on, and
// the actions agents can take there. Every action updates the browser's row
// so the JMCP app shows where it is.

const path = require("node:path");
const crypto = require("node:crypto");
const cdp = require("./cdp.js");
const store = require("./store.js");

// Marks visible interactive elements with data-jmcp-ref and lists them, so
// an agent can click or type by number.
const SNAPSHOT = `(() => {
  const MAX = 300;
  for (const e of document.querySelectorAll("[data-jmcp-ref]")) e.removeAttribute("data-jmcp-ref");
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const out = [];
  let n = 0, skipped = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (n >= MAX) { skipped++; continue; }
    n++;
    el.setAttribute("data-jmcp-ref", String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const field = tag === "textarea" || (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"].includes(type));
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "select" ? "select" : field ? "textbox" : tag === "input" ? (["submit", "button", "reset", "image"].includes(type) ? "button" : type) : tag === "button" || tag === "summary" ? "button" : "clickable");
    const labelled = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    const label = tag === "input" || tag === "textarea" || tag === "select"
      ? clean(el.getAttribute("aria-label") || labelled || el.getAttribute("placeholder") || el.getAttribute("title") || el.name || (["submit", "button", "reset"].includes(type) ? el.value : ""), 100)
      : clean(el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || (el.querySelector("img[alt]") || {}).alt || "", 100);
    let extra = "";
    if (field && type && type !== "text") extra += " type=" + type;
    if (field && el.value) extra += type === "password" ? " (filled)" : ' value="' + clean(el.value, 80) + '"';
    if (tag === "select" && el.selectedOptions && el.selectedOptions[0]) extra += ' selected="' + clean(el.selectedOptions[0].text, 60) + '"';
    if ((type === "checkbox" || type === "radio") && el.checked) extra += " checked";
    if (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") extra += " selected";
    if (tag === "a" && el.href) extra += " -> " + el.href.slice(0, 160);
    if (el.disabled) extra += " disabled";
    out.push("[" + n + "] " + role + (label ? ' "' + label + '"' : "") + extra);
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { url: location.href, title: document.title, elements: out, skipped, text };
})()`;

// Finds the target element, scrolls it into view and returns its center.
function locate(t) {
  return `(() => {
  const t = ${JSON.stringify(t)};
  let el = null;
  if (t.ref !== undefined) el = document.querySelector('[data-jmcp-ref="' + String(t.ref).replace(/[^0-9]/g, "") + '"]');
  else if (t.selector) el = document.querySelector(t.selector);
  else if (t.text) {
    const want = t.text.toLowerCase();
    const all = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick]')];
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => String(e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().toLowerCase();
    el = all.find((e) => seen(e) && txt(e) === want) || all.find((e) => seen(e) && txt(e).includes(want)) || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const name = el.tagName.toLowerCase() + (String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim() ? ' "' + String(el.innerText || el.value || el.getAttribute("aria-label")).replace(/\\s+/g, " ").trim().slice(0, 60) + '"' : "");
  return { x, y, covered: !(hit && (hit === el || el.contains(hit) || hit.contains(el))), name };
})()`;
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};

// http(s), file, about and data only. "example.com" means https://example.com.
function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("url must not be empty.");
  // "localhost:3000" is a host and port, not a scheme.
  if (!/^([a-z][a-z0-9+.-]*:\/\/|(about|data|javascript|vbscript|mailto|blob|chrome|edge|view-source|file):)/i.test(s)) s = (/^(localhost|127\.|\[::1\])/i.test(s) ? "http://" : "https://") + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Not a URL: " + raw);
  }
  if (!["http:", "https:", "file:", "about:", "data:"].includes(u.protocol)) throw new Error("Only http, https, file, about and data URLs can be opened, not " + u.protocol);
  return u.href;
}

class Session {
  constructor(o) {
    Object.assign(this, o);
    this.page = null;
    this.targetId = "";
    this.known = new Set();
    this.loading = false;
    this.mainFrame = "";
    this.dialog = "";
  }

  static async open(opts) {
    const programs = cdp.findBrowsers();
    if (!programs.length) throw new Error("No Chrome, Edge or Chromium was found on this computer. Install one, or set JMCP_BROWSER to the browser's program file.");
    const profile = path.join(store.dbHome(), "browser", "profiles", crypto.randomUUID());
    // A browser that will not start (Chrome waiting to finish an update
    // quits at once) hands over to the next one found.
    let started = null;
    let program = "";
    const failures = [];
    for (program of programs) {
      try {
        started = await cdp.launch(program, profile, { width: opts.width, height: opts.height });
        break;
      } catch (e) {
        failures.push(path.basename(program) + ": " + e.message);
        await cdp.removeProfile(profile);
      }
    }
    if (!started) throw new Error("No browser would start. " + failures.join(" "));
    const { pid, port, browserWs } = started;
    const s = new Session({ name: opts.name, pid, port, browserWs, program, profile });
    try {
      s.row = store.add(undefined, { name: opts.name, agent: opts.agent, cwd: opts.cwd, serverPid: process.pid, browserPid: pid, port, browserWs, program, profile });
      const list = await cdp.pages(port);
      for (const t of list) s.known.add(t.id);
      if (!list.length) throw new Error("The browser opened with no page.");
      await s.attach(list[0]);
      s.row = store.touch(undefined, s.row.id, { target_id: list[0].id });
    } catch (e) {
      await s.close("Could not start: " + e.message);
      throw e;
    }
    return s;
  }

  async attach(target) {
    const old = this.page;
    this.page = null;
    if (old) old.close();
    this.targetId = target.id;
    const page = await cdp.connect(target.webSocketDebuggerUrl);
    this.page = page;
    // The page's connection drops when the browser quits or is closed from
    // the JMCP app.
    page.on("close", () => {
      if (page === this.page && !this.closing) this.gone = true;
    });
    page.on("Page.frameStartedLoading", (p) => {
      if (!this.mainFrame || p.frameId === this.mainFrame) this.loading = true;
    });
    page.on("Page.frameStoppedLoading", (p) => {
      if (!this.mainFrame || p.frameId === this.mainFrame) this.loading = false;
    });
    page.on("Page.loadEventFired", () => (this.loading = false));
    // A dialog would hold the page still; accept it and tell the agent.
    page.on("Page.javascriptDialogOpening", (p) => {
      this.dialog = p.type + ': "' + String(p.message || "").slice(0, 200) + '"';
      page.send("Page.handleJavaScriptDialog", { accept: true, promptText: p.defaultPrompt || "" }).catch(() => {});
    });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    // The app's live view and control follow the page the agent is on.
    if (this.row) this.row = store.touch(undefined, this.row.id, { target_id: target.id });
    const tree = await page.send("Page.getFrameTree");
    this.mainFrame = tree.frameTree.frame.id;
  }

  // Wait for a navigation the last action started, if any.
  async settle(ms) {
    await cdp.sleep(ms || 300);
    const until = Date.now() + 20000;
    while (this.loading && Date.now() < until) await cdp.sleep(100);
    // A link that opened a new tab: follow it.
    try {
      const list = await cdp.pages(this.port);
      const fresh = list.filter((t) => !this.known.has(t.id));
      for (const t of list) this.known.add(t.id);
      if (fresh.length) {
        await this.attach(fresh[fresh.length - 1]);
        this.newTab = true;
        const end = Date.now() + 15000;
        while (Date.now() < end && (await this.eval("document.readyState", true)) !== "complete") await cdp.sleep(150);
      }
    } catch {
      /* keep the current page */
    }
  }

  async eval(expression, quiet) {
    const r = await this.page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, 30000);
    if (r.exceptionDetails) {
      if (quiet) return undefined;
      const d = r.exceptionDetails;
      throw new Error("The page threw: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async where(action) {
    const info = (await this.eval("({ url: location.href, title: document.title })", true)) || { url: "", title: "" };
    this.row = store.touch(undefined, this.row.id, { url: info.url, title: info.title, last_action: action });
    return info;
  }

  // Lines that end each action's reply: where the page is now, and anything
  // the agent should know (a dialog accepted, a new tab followed).
  async after(action) {
    const info = await this.where(action);
    const notes = [];
    if (this.newTab) notes.push("The page opened a new tab; this browser now shows it.");
    if (this.dialog) notes.push("The page showed a " + this.dialog + " dialog; it was accepted.");
    this.newTab = false;
    this.dialog = "";
    return [action + ".", "Page: " + (info.title || "(no title)") + " | " + info.url, ...notes].join("\n");
  }

  async navigate(url) {
    const href = normalizeUrl(url);
    this.loading = true;
    const r = await this.page.send("Page.navigate", { url: href }, 30000);
    if (r.errorText) {
      this.loading = false;
      await this.where("Could not open " + href);
      throw new Error("Could not open " + href + ": " + r.errorText);
    }
    if (!r.loaderId) this.loading = false;
    await this.settle(100);
    return this.after("Opened " + href);
  }

  // Ask the user to take over in the JMCP app and wait until they hand the
  // browser back, it closes, or the time runs out.
  async handoff(reason, timeoutSec) {
    const asked = store.ask(undefined, this.row.id, reason);
    const since = asked.ask_at;
    const until = Date.now() + timeoutSec * 1000;
    while (Date.now() < until) {
      const row = store.byId(undefined, this.row.id);
      if (!row || row.status !== "open") throw new Error("The browser was closed while waiting for the user" + (row && row.closed_reason ? ": " + row.closed_reason : "."));
      if (!row.control && row.handed_back_at >= since) {
        // The user may have opened a new tab or moved on; follow the page.
        await this.settle(100);
        const note = row.user_note ? "\nThe user says: " + row.user_note : "";
        return (await this.after("The user handed the browser back")) + note + "\nRead the page with browser_snapshot before you go on.";
      }
      await cdp.sleep(1000);
    }
    return "The user has not handed the browser back after " + timeoutSec + " seconds. It is still waiting for them in the JMCP app. Call browser_handoff again to keep waiting, or tell the user what you need.";
  }

  async back() {
    const h = await this.page.send("Page.getNavigationHistory");
    if (h.currentIndex <= 0) throw new Error("There is no page to go back to.");
    this.loading = true;
    await this.page.send("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
    await this.settle(200);
    return this.after("Went back");
  }

  async snapshot(maxText) {
    const s = await this.eval(SNAPSHOT);
    await this.where("Read the page");
    const limit = Math.max(0, Math.min(100000, Number.isFinite(maxText) ? maxText : 8000));
    const text = s.text.length > limit ? s.text.slice(0, limit) + "\n(The text goes on: " + (s.text.length - limit) + " more characters. Pass a larger max_text to read more.)" : s.text;
    return [
      "Page: " + (s.title || "(no title)") + " | " + s.url,
      "",
      "Elements (click or type by ref number):",
      s.elements.length ? s.elements.join("\n") : "(none visible)",
      s.skipped ? "(" + s.skipped + " more elements were not listed.)" : "",
      "",
      "Text:",
      text || "(no text)",
    ].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
  }

  async target(t) {
    const spot = await this.eval(locate(t));
    if (!spot) {
      const what = t.ref !== undefined ? "ref " + t.ref + " (refs change when the page changes; read the page again)" : t.selector ? "selector " + t.selector : 'text "' + t.text + '"';
      throw new Error("Nothing on the page matches " + what + ".");
    }
    return spot;
  }

  async mouseClick(x, y) {
    const base = { x, y, button: "left", clickCount: 1 };
    await this.page.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseMoved" }, base, { button: "none" }));
    await this.page.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed" }, base));
    await this.page.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased" }, base));
  }

  async click(t) {
    const spot = await this.target(t);
    await this.mouseClick(spot.x, spot.y);
    await this.settle(400);
    return this.after("Clicked " + spot.name + (spot.covered ? " (another element was on top of it, so that one may have got the click)" : ""));
  }

  async type(t, text, opts) {
    const spot = await this.target(t);
    await this.mouseClick(spot.x, spot.y);
    if (!opts.append) {
      await this.eval(`(() => { const el = document.activeElement; if (!el) return; if ("value" in el && el.tagName !== "BUTTON") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el.isContentEditable) { el.textContent = ""; } })()`, true);
    }
    await this.page.send("Input.insertText", { text });
    if (opts.submit) await this.press("Enter", true);
    await this.settle(opts.submit ? 400 : 100);
    // The text itself stays out of the app's log: it may be a password.
    return this.after("Typed " + text.length + " characters into " + spot.name + (opts.submit ? " and pressed Enter" : ""));
  }

  async press(key, quiet) {
    const k = KEYS[key] || (key.length === 1 ? { code: "", keyCode: key.toUpperCase().charCodeAt(0), text: key, key } : null);
    if (!k) throw new Error("Unknown key " + key + ". Use one character or one of: " + Object.keys(KEYS).join(", ") + ".");
    const ev = { key: k.key || key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.page.send("Input.dispatchKeyEvent", Object.assign({ type: k.text ? "keyDown" : "rawKeyDown", text: k.text }, ev));
    await this.page.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, ev));
    if (quiet) return "";
    await this.settle(300);
    return this.after("Pressed " + key);
  }

  async screenshot(fullPage) {
    const r = await this.page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(fullPage) }, 30000);
    await this.where("Took a screenshot");
    return r.data;
  }

  async evaluate(expression) {
    const v = await this.eval(expression);
    await this.settle(100);
    await this.where("Ran a script");
    const s = v === undefined ? "undefined" : JSON.stringify(v, null, 1);
    return s.length > 20000 ? s.slice(0, 20000) + "\n(cut at 20000 characters)" : s;
  }

  // Quit the browser, mark its row closed and delete its profile.
  async close(reason) {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.page) this.page.close();
      await cdp.closeBrowser(this.browserWs);
      const until = Date.now() + 3000;
      while (Date.now() < until && store.alive(this.pid)) await cdp.sleep(100);
      if (store.alive(this.pid) && (await cdp.sameBrowser(this.port, this.browserWs))) await cdp.killPid(this.pid);
      if (this.row) store.close(undefined, this.row.id, reason || "Closed by the agent.");
      await cdp.removeProfile(this.profile);
    })();
    return this.closing;
  }
}

module.exports = { Session, normalizeUrl, KEYS, SNAPSHOT };
