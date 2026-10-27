"use strict";

// jmcp-browser: its database, argument checks, and the server driving a real
// headless browser (hidden, scratch profile) against a local test page.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { connect } = require("../core/mcp-client.cjs");
const store = require("../servers/browser/lib/store.js");
const cdp = require("../servers/browser/lib/cdp.js");
const { normalizeUrl } = require("../servers/browser/lib/session.js");
const { methods, TOOLS } = require("../servers/browser/server.cjs");
const browsers = require("../core/browser.cjs");

const SERVER = path.join(__dirname, "..", "servers", "browser", "server.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-browser-"));
const HAVE = Boolean(cdp.findBrowser());

const PAGE = `<!doctype html><title>Test home</title>
<h1>Hello from the test page</h1>
<a href="/two">Go to page two</a>
<form action="/search"><label>Search <input name="q"></label><button>Find</button></form>
<button onclick="document.body.dataset.clicked='yes'; document.querySelector('h1').textContent='Clicked'">Press me</button>
<a href="/two" target="_blank">New tab link</a>`;

function site() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      res.setHeader("content-type", "text/html");
      if (u.pathname === "/two") return res.end("<!doctype html><title>Page two</title><p>Second page text</p>");
      if (u.pathname === "/search") return res.end("<!doctype html><title>Results</title><p>You searched for " + String(u.searchParams.get("q")).replace(/[<&]/g, "") + "</p>");
      res.end(PAGE);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("store adds, updates and closes browser rows", () => {
  const home = scratch();
  const row = store.add(home, { name: "browser-1", agent: "claude-code", cwd: "C:/x", serverPid: process.pid, browserPid: 1, port: 9, browserWs: "ws://127.0.0.1:9/devtools/browser/a", program: "chrome", profile: path.join(home, "p") });
  assert.strictEqual(row.status, "open");
  assert.strictEqual(store.open(home).length, 1);
  const t = store.touch(home, row.id, { url: "https://example.com/", title: "Example", last_action: "Opened", status: "closed" });
  assert.strictEqual(t.title, "Example");
  assert.strictEqual(t.status, "open");
  assert.ok(store.close(home, row.id, "done"));
  assert.ok(!store.close(home, row.id, "again"));
  assert.strictEqual(store.open(home).length, 0);
  assert.strictEqual(store.recent(home, 5)[0].closed_reason, "done");
  assert.ok(fs.existsSync(path.join(home, ".jmcp", "browser.db")));
});

test("an older browsers table gets the hand-off columns", () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, ".jmcp"));
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(home, ".jmcp", "browser.db"));
  db.exec("CREATE TABLE browsers (id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, server_pid INTEGER NOT NULL, browser_pid INTEGER, port INTEGER, browser_ws TEXT, program TEXT NOT NULL, profile TEXT NOT NULL, status TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', last_action TEXT NOT NULL DEFAULT '', closed_reason TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER)");
  db.close();
  const row = store.add(home, { name: "browser-1", agent: "a", cwd: "", serverPid: process.pid, program: "chrome", profile: "p" });
  assert.strictEqual(row.control, "");
  assert.strictEqual(store.ask(home, row.id, "Log in").control, "asked");
  assert.ok(store.takeControl(home, row.id));
  assert.strictEqual(store.ask(home, row.id, "Still").control, "user");
  assert.ok(store.handBack(home, row.id, "done"));
  assert.ok(!store.handBack(home, row.id, "again"));
  const back = store.byId(home, row.id);
  assert.strictEqual(back.control, "");
  assert.strictEqual(back.user_note, "done");
  assert.ok(back.handed_back_at >= back.ask_at);
});

test("URLs are checked and completed", () => {
  assert.strictEqual(normalizeUrl("example.com"), "https://example.com/");
  assert.strictEqual(normalizeUrl("localhost:3000/a"), "http://localhost:3000/a");
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /Only http/);
  assert.throws(() => normalizeUrl(" "), /must not be empty/);
});

test("tools refuse bad arguments and unknown tools", async () => {
  await assert.rejects(() => methods["tools/call"]({ name: "nope", arguments: {} }), /Unknown tool/);
  const r = await methods["tools/call"]({ name: "browser_navigate", arguments: {} });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /url is required/);
  const r2 = await methods["tools/call"]({ name: "browser_snapshot", arguments: {} });
  assert.ok(r2.isError);
  assert.match(r2.content[0].text, /No browser is open/);
  assert.ok(TOOLS.every((t) => t.inputSchema.type === "object"));
});

test("sweep closes rows whose server is gone without touching other processes", async () => {
  const home = scratch();
  const profile = path.join(home, "profile");
  fs.mkdirSync(profile);
  // pid 999999 is no server; port 1 answers nothing, so no process is killed.
  store.add(home, { name: "browser-1", agent: "a", cwd: "", serverPid: 999999, browserPid: process.pid, port: 1, browserWs: "ws://127.0.0.1:1/devtools/browser/x", program: "chrome", profile });
  const list = await browsers.list(home);
  assert.strictEqual(list.open.length, 0);
  assert.strictEqual(list.recent[0].closedReason, "The agent's session ended.");
  assert.ok(!fs.existsSync(profile));
});

test("a real agent session: open, read, click, type, new tab, screenshot, app view, close", { skip: !HAVE && "no Chrome or Edge" }, async () => {
  const home = scratch();
  const srv = await site();
  const base = "http://127.0.0.1:" + srv.address().port;
  const c = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
  try {
    await c.initialize("browser-test", 20000);
    let r = await c.callTool("browser_open", { url: base + "/" }, 60000);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Opened browser-1/);
    assert.match(r.text, /Test home/);

    // The app sees the browser and can take a live screenshot of it.
    const seen = await browsers.list(home);
    assert.strictEqual(seen.open.length, 1);
    assert.strictEqual(seen.open[0].agent, "browser-test");
    assert.strictEqual(seen.open[0].title, "Test home");
    const shot = await browsers.screenshot(home, seen.open[0].id);
    assert.match(shot.src, /^data:image\/jpeg;base64,/);
    assert.ok(shot.width > 300 && shot.height > 200, JSON.stringify([shot.width, shot.height]));

    r = await c.callTool("browser_snapshot", {}, 30000);
    assert.match(r.text, /Hello from the test page/);
    // Same-site links show only their path.
    assert.match(r.text, /link "Go to page two" -> \/two\n/);
    const one = await c.callTool("browser_snapshot", { max_elements: 1 }, 30000);
    assert.strictEqual(one.text.split("\n").filter((l) => /^\[\d+\] /.test(l)).length, 1);
    assert.match(one.text, /more elements were not listed. Pass a larger max_elements/);
    r = await c.callTool("browser_snapshot", {}, 30000);
    const ref =(label) => Number(new RegExp("\\[(\\d+)\\] [a-z]+ \"" + label).exec(r.text)[1]);

    r = await c.callTool("browser_click", { ref: ref("Press me") }, 30000);
    assert.ok(!r.isError, r.text);
    r = await c.callTool("browser_eval", { expression: "document.body.dataset.clicked" }, 30000);
    assert.strictEqual(r.text.trim(), '"yes"');

    r = await c.callTool("browser_snapshot", {}, 30000);
    r = await c.callTool("browser_type", { ref: ref("Search"), value: "kittens", submit: true }, 30000);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Results/);
    r = await c.callTool("browser_snapshot", {}, 30000);
    assert.match(r.text, /You searched for kittens/);

    r = await c.callTool("browser_back", {}, 30000);
    assert.match(r.text, /Test home/);
    r = await c.callTool("browser_click", { text: "Go to page two" }, 30000);
    assert.match(r.text, /Page two/);

    await c.callTool("browser_navigate", { url: base + "/" }, 30000);
    r = await c.callTool("browser_click", { text: "New tab link" }, 30000);
    assert.match(r.text, /new tab/);
    assert.match(r.text, /Page two/);

    r = await c.callTool("browser_click", { ref: 999 }, 30000);
    assert.ok(r.isError);
    assert.match(r.text, /Nothing on the page matches ref 999/);
    r = await c.callTool("browser_click", { ref: 1, text: "x" }, 30000);
    assert.match(r.text, /exactly one/);

    const raw = await c.request("tools/call", { name: "browser_screenshot", arguments: {} }, 30000);
    assert.strictEqual(raw.content[0].type, "image");
    assert.ok(Buffer.from(raw.content[0].data, "base64").subarray(1, 4).toString() === "PNG");

    r = await c.callTool("browser_navigate", { url: "file:///nope-" + Date.now() }, 30000);
    assert.ok(r.isError);

    // The agent hands the browser to the user and waits.
    await c.callTool("browser_navigate", { url: base + "/" }, 30000);
    r = await c.callTool("browser_eval", { expression: "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Press me').getBoundingClientRect(); const q = document.querySelector('input[name=q]').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, q.x + 5, q.y + q.height / 2]; })()" }, 30000);
    const [bx, by, qx, qy] = JSON.parse(r.text);
    const bid = (await browsers.list(home)).open[0].id;
    await assert.rejects(() => browsers.input(home, bid, { type: "down", x: bx, y: by }), /Take control/);
    r = await c.callTool("browser_handoff", { reason: " " }, 30000);
    assert.match(r.text, /reason must say/);
    const waiting = c.callTool("browser_handoff", { reason: "Solve the CAPTCHA", timeout_sec: 60 }, 90000);
    let asked;
    for (let i = 0; i < 50 && !(asked && asked.control === "asked"); i++) {
      await new Promise((res) => setTimeout(res, 100));
      asked = (await browsers.list(home)).open[0];
    }
    assert.strictEqual(asked.control, "asked");
    assert.strictEqual(asked.askReason, "Solve the CAPTCHA");
    assert.ok(browsers.takeControl(home, bid));
    assert.strictEqual((await browsers.list(home)).open[0].control, "user");

    // A second session of the same server cannot act while the user drives.
    const c2 = connect(process.execPath, [SERVER], { env: { JMCP_HOME: path.join(home, ".jmcp") } });
    await c2.initialize("other", 20000);
    c2.close();

    // The user clicks and types through the app.
    await browsers.input(home, bid, { type: "down", x: bx, y: by });
    await browsers.input(home, bid, { type: "up", x: bx, y: by });
    await browsers.input(home, bid, { type: "down", x: qx, y: qy });
    await browsers.input(home, bid, { type: "up", x: qx, y: qy });
    await browsers.input(home, bid, { type: "text", text: "by hand" });
    await browsers.input(home, bid, { type: "wheel", x: 10, y: 10, dy: 100 });
    await assert.rejects(() => browsers.input(home, bid, { type: "key", key: "F13" }), /Unknown key/);
    await assert.rejects(() => browsers.input(home, bid, { type: "down", x: "1", y: 2 }), /x must be a number/);
    assert.ok(browsers.handBack(home, bid, "Solved it"));
    r = await waiting;
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /The user handed the browser back/);
    assert.match(r.text, /The user says: Solved it/);
    r = await c.callTool("browser_eval", { expression: "[document.body.dataset.clicked, document.querySelector('input[name=q]').value]" }, 30000);
    assert.deepStrictEqual(JSON.parse(r.text), ["yes", "by hand"]);
    await assert.rejects(() => browsers.input(home, bid, { type: "text", text: "x" }), /Take control/);

    // While the user has control without being asked, actions wait for them.
    browsers.takeControl(home, bid);
    r = await c.callTool("browser_click", { text: "Press me" }, 30000);
    assert.ok(r.isError);
    assert.match(r.text, /taken control/);
    r = await c.callTool("browser_snapshot", {}, 30000);
    assert.ok(!r.isError);
    r = await c.callTool("browser_handoff", { reason: "Finish up", timeout_sec: 10 }, 30000);
    assert.match(r.text, /has not handed the browser back after 10 seconds/);
    browsers.handBack(home, bid, "");

    // The user closes it from the app; the agent is told on its next call.
    const id = (await browsers.list(home)).open[0].id;
    const profile = store.byId(home, id).profile;
    await browsers.close(home, id);
    assert.strictEqual((await browsers.list(home)).open.length, 0);
    r = await c.callTool("browser_snapshot", {}, 30000);
    assert.ok(r.isError);
    assert.match(r.text, /was closed: Closed from the JMCP app/);
    assert.ok(!fs.existsSync(profile));

    // A second browser closes when the agent's session ends.
    r = await c.callTool("browser_open", {}, 60000);
    assert.match(r.text, /browser-2/);
    const row = (await browsers.list(home)).open[0];
    c.child.stdin.end();
    await new Promise((res) => (c.child.exitCode != null ? res() : c.child.once("exit", res)));
    const after = store.byId(home, row.id);
    assert.strictEqual(after.status, "closed");
    assert.strictEqual(after.closed_reason, "The agent's session ended.");
    assert.ok(!store.alive(row.browser_pid));
  } finally {
    c.close();
    srv.close();
  }
});
