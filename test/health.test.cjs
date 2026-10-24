"use strict";

// jmcp-health: parsing, problem rules and the MCP surface. The real checks
// against this computer and SSH hosts are run by hand (they need real hosts).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connect } = require("../core/mcp-client.cjs");
const { parseLinux, sshHosts, checkTarget } = require("../servers/health/lib/collect.js");
const { analyze } = require("../servers/health/lib/analyze.js");
const { inspectHtml, pageProblems } = require("../servers/health/lib/page.js");

const SERVER = path.join(__dirname, "..", "servers", "health", "server.cjs");

const LINUX = `@@uname
Linux 6.8.0 x86_64
@@hostname
web1
@@uptime
86400.5 1000
@@loadavg
9.10 8.00 7.00 3/200 1234
@@nproc
4
@@meminfo
MemTotal:        2048000 kB
MemFree:           50000 kB
MemAvailable:     100000 kB
SwapTotal:       1024000 kB
SwapFree:         200000 kB
@@df
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 20000000 19500000 500000 98% /
/dev/sda2 1000000 300000 700000 30% /boot
@@stat1
cpu 100 0 100 700 100 0 0 0
@@stat2
cpu 160 0 140 720 180 0 0 0
@@ps
COMMAND %CPU RSS
node 150.0 900000
@@oom
3
@@failed
nginx.service loaded failed failed nginx
@@docker
api Restarting (1) 5 seconds ago
@@end
`;

test("parses Linux collector output", () => {
  const f = parseLinux(LINUX);
  assert.strictEqual(f.system.hostname, "web1");
  assert.strictEqual(f.cpu.cores, 4);
  assert.strictEqual(f.cpu.iowaitPct, 40);
  assert.strictEqual(f.procs[0].name, "node");
  assert.strictEqual(f.disks.length, 2);
  assert.deepStrictEqual(f.events.failedUnits, ["nginx.service"]);
});

test("analyze flags real problems and leaves small healthy partitions alone", () => {
  const titles = analyze(parseLinux(LINUX)).map((p) => p.title).join("\n");
  assert.match(titles, /Memory is almost full/);
  assert.match(titles, /Load average/);
  assert.match(titles, /waiting on disk/);
  assert.match(titles, /^\/ is nearly full/m);
  assert.doesNotMatch(titles, /\/boot/);
  assert.match(titles, /Out-of-memory killer/);
  assert.match(titles, /nginx\.service/);
  assert.match(titles, /Containers unhealthy/);
});

test("Windows facts: GPU resets, WHEA and disabled acceleration", () => {
  const p = analyze({
    os: "windows",
    system: { totalMB: 16000, freeMB: 8000, uptimeSec: 100 },
    events: { gpuResets: 2, whea: 1 },
    browsers: [{ name: "Chrome", hardwareAcceleration: false, extensions: 3 }],
  });
  const glitch = p.filter((x) => x.affects.includes("glitch")).map((x) => x.area);
  assert.ok(glitch.includes("gpu") && glitch.includes("hardware"));
  assert.ok(p.some((x) => x.area === "browser" && x.affects.includes("text")));
});

test("page check finds font and render blocking causes", () => {
  const html = `<html><head><link rel="stylesheet" href="a.css"><script src="x.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head><body><div id="root"></div></body></html>`;
  const h = inspectHtml(html, "@font-face { font-family: X; src: url(x.woff2); }");
  assert.strictEqual(h.fontNoSwap, 1);
  assert.strictEqual(h.googleNoSwap, 1);
  assert.strictEqual(h.blockingJs, 1);
  assert.strictEqual(h.clientRendered, true);
  const titles = pageProblems({ status: 200, timing: { dnsMs: 10, connectMs: 10, tlsMs: 10, waitMs: 2000, downloadMs: 10 }, redirectMs: 0, wireBytes: 1000 }, h).map((p) => p.title);
  assert.ok(titles.some((t) => /Web fonts hide text/.test(t)));
  assert.ok(titles.some((t) => /first byte/.test(t)));
});

test("ssh config hosts and target validation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jmcp-health-"));
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.writeFileSync(path.join(home, ".ssh", "config"), "# Web box\nHost web *.lan\n  HostName 10.0.0.2\n  User me\n\nHost *\n  ServerAliveInterval 5\n");
  assert.deepStrictEqual(sshHosts(home), [{ name: "web", note: "Web box", hostname: "10.0.0.2", user: "me" }]);
  assert.strictEqual(checkTarget(undefined), "local");
  assert.strictEqual(checkTarget("me@host.lan"), "me@host.lan");
  assert.throws(() => checkTarget("-oProxyCommand=calc"), /Bad target/);
  assert.throws(() => checkTarget("a;b"), /Bad target/);
});

test("MCP server lists its tools and rejects bad targets", async () => {
  const c = connect(process.execPath, [SERVER], {});
  try {
    const init = await c.initialize("test");
    assert.strictEqual(init.serverInfo.name, "jmcp-health");
    const { tools } = await c.request("tools/list");
    assert.deepStrictEqual(tools.map((t) => t.name), ["targets", "problems", "slow_text", "glitchy", "updates", "show_user"]);
    const r = await c.request("tools/call", { name: "problems", arguments: { target: "-oX" } });
    assert.strictEqual(r.isError, true);
    const u = await c.request("tools/call", { name: "updates", arguments: { target: "not-a-configured-host", install: true } });
    assert.strictEqual(u.isError, true);
    assert.match(u.content[0].text, /Unknown host/);
  } finally {
    c.close();
  }
});

test("only a disk that says Healthy counts as healthy", () => {
  const { analyze } = require("../servers/health/lib/analyze.js");
  const bad = analyze({ os: "windows", physicalDisks: [{ name: "Disk 0", health: "Unhealthy", media: "SSD", bus: "NVMe" }] });
  assert.ok(bad.some((p) => /reports Unhealthy/.test(p.title)));
  const good = analyze({ os: "windows", physicalDisks: [{ name: "Disk 0", health: "Healthy", media: "SSD", bus: "NVMe" }] });
  assert.ok(!good.some((p) => /reports/.test(p.title)));
});
