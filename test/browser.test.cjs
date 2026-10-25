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
    assert.match(shot, /^data:image\/jpeg;base64,/);

    r = await c.callTool("browser_snapshot", {}, 30000);
    assert.match(r.text, /Hello from the test page/);
    const ref = (label) => Number(new RegExp("\\[(\\d+)\\] [a-z]+ \"" + label).exec(r.text)[1]);

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
