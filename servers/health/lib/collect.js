"use strict";

// Runs the collector script on this computer or on an SSH host and turns its
// output into one facts object. Every child process starts hidden.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PS1 = fs.readFileSync(path.join(__dirname, "windows.ps1"), "utf8");
const SH = fs.readFileSync(path.join(__dirname, "linux.sh"), "utf8");

// Reads a base64 script from stdin and runs it. Short enough for cmd.exe and
// carries no quotes, so it works whether the SSH host's shell is cmd or pwsh.
const BOOT = Buffer.from(
  "$s=[Console]::In.ReadToEnd();$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s));& ([scriptblock]::Create($t))",
  "utf16le"
).toString("base64");
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", BOOT];

function run(cmd, args, input, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ code: -1, out, err: err + "\nTimed out after " + timeoutMs / 1000 + "s." });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message || e) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

function sshConfigPath(home) {
  return path.join(home || os.homedir(), ".ssh", "config");
}

// Named hosts from ~/.ssh/config (wildcard patterns are skipped).
function sshHosts(home) {
  let text = "";
  try {
    text = fs.readFileSync(sshConfigPath(home), "utf8");
  } catch {
    return [];
  }
  const hosts = [];
  let cur = null;
  let comment = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      comment = line.replace(/^#+\s*/, "");
      continue;
    }
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      if (!line) comment = "";
      continue;
    }
    const key = m[1].toLowerCase();
    if (key === "host") {
      cur = null;
      for (const name of m[2].split(/\s+/)) {
        if (/[*?!]/.test(name)) continue;
        cur = { name, note: comment || undefined };
        hosts.push(cur);
      }
      comment = "";
    } else if (cur && key === "hostname") cur.hostname = m[2];
    else if (cur && key === "user") cur.user = m[2];
    else if (cur && key === "proxyjump") cur.via = m[2];
  }
  return hosts;
}

function checkTarget(target) {
  const t = String(target || "local").trim();
  if (t === "local" || t === "localhost") return "local";
  if (!/^[\w.@:\-[\]]+$/.test(t) || t.startsWith("-")) throw new Error("Bad target " + JSON.stringify(t) + ". Use \"local\", an alias from ~/.ssh/config, or user@host.");
  return t;
}

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];

function ssh(target, remoteCmd, input, timeoutMs) {
  return run("ssh", [...SSH_OPTS, "-T", target, remoteCmd], input, timeoutMs);
}

// Facts for "local" or an SSH target. Throws with the reason when the target
// cannot be reached or the collector fails.
async function collect(target, opts) {
  const t = checkTarget(target);
  const timeoutMs = (opts && opts.timeoutMs) || 90000;
  const started = Date.now();
  let kind;
  let res;
  if (t === "local") {
    kind = process.platform === "win32" ? "windows" : "linux";
    res = kind === "windows" ? await run("powershell.exe", PS_ARGS, Buffer.from(PS1).toString("base64"), timeoutMs) : await run("sh", ["-s"], SH, timeoutMs);
  } else {
    const probe = await ssh(t, "uname -s", "", 30000);
    if (probe.code === 255 || (probe.code !== 0 && !probe.out && /ssh:|Permission denied|Could not resolve|timed out|Connection refused|Host key/i.test(probe.err))) {
      throw new Error("Could not connect to " + t + ": " + probe.err.trim().split(/\r?\n/).slice(-3).join(" "));
    }
    const sys = probe.code === 0 ? probe.out.trim() : "";
    if (/linux/i.test(sys)) kind = "linux";
    else if (sys) throw new Error(t + " runs " + sys + ". Only Linux and Windows hosts are supported.");
    else kind = "windows";
    res = kind === "linux" ? await ssh(t, "sh -s", SH, timeoutMs) : await ssh(t, "powershell " + PS_ARGS.join(" "), Buffer.from(PS1).toString("base64"), timeoutMs);
  }
  if (!res.out.trim()) throw new Error("Collector on " + t + " returned nothing (exit " + res.code + "): " + res.err.trim().slice(-400));
  const facts = kind === "windows" ? parseWindows(res.out) : parseLinux(res.out);
  facts.target = t;
  facts.collectMs = Date.now() - started;
  return facts;
}

function parseWindows(out) {
  const start = out.indexOf("{");
  if (start < 0) throw new Error("Windows collector printed no JSON: " + out.slice(0, 300));
  const f = JSON.parse(out.slice(start));
  for (const k of ["procs", "disks", "physicalDisks", "gpu", "thermal", "browsers", "display"]) {
    if (f[k] && !Array.isArray(f[k])) f[k] = [f[k]];
  }
  if (f.events) for (const k of ["appCrashes", "appHangs"]) if (f.events[k] && !Array.isArray(f.events[k])) f.events[k] = [f.events[k]];
  return f;
}

function sections(out) {
  const s = {};
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      cur = m[1];
      s[cur] = [];
    } else if (cur) s[cur].push(line);
  }
  return s;
}

const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

function parseLinux(out) {
  const s = sections(out);
  const first = (k) => ((s[k] || []).find((l) => l.trim()) || "").trim();
  const f = { os: "linux" };
  const mem = {};
  for (const l of s.meminfo || []) {
    const m = l.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/);
    if (m) mem[m[1]] = +m[2];
  }
  const totalMB = Math.round((mem.MemTotal || 0) / 1024);
  const availMB = Math.round((mem.MemAvailable ?? mem.MemFree ?? 0) / 1024);
  f.system = {
    hostname: first("hostname"),
    caption: first("osrelease") || first("uname"),
    kernel: first("uname"),
    uptimeSec: Math.round(num(first("uptime").split(/\s+/)[0]) || 0),
    totalMB,
    freeMB: availMB,
  };
  const load = first("loadavg").split(/\s+/).map(num);
  const cores = num(first("nproc")) || 1;
  const cpuTimes = (k) => first(k).split(/\s+/).slice(1).map(Number);
  const a = cpuTimes("stat1");
  const b = cpuTimes("stat2");
  let loadPct = null;
  let iowaitPct = null;
  let stealPct = null;
  if (a.length >= 4 && b.length >= 4) {
    const d = b.map((v, i) => v - (a[i] || 0));
    const total = d.reduce((x, y) => x + y, 0) || 1;
    const idle = (d[3] || 0) + (d[4] || 0);
    loadPct = Math.round((100 * (total - idle)) / total);
    iowaitPct = Math.round((100 * (d[4] || 0)) / total);
    stealPct = Math.round((100 * (d[7] || 0)) / total);
  }
  f.cpu = { model: first("cpumodel"), cores, loadPct, load1: load[0], load5: load[1], load15: load[2], iowaitPct, stealPct };
  const parsePs = (k) =>
    (s[k] || [])
      .slice(1)
      .map((l) => l.trim().match(/^(.+?)\s+([\d.]+)\s+(\d+)$/))
      .filter(Boolean)
      .map((m) => ({ name: m[1], cpuPct: Math.round((+m[2] / cores) * 10) / 10, memMB: Math.round(+m[3] / 1024) }));
  const procs = parsePs("ps");
  for (const p of parsePs("psmem")) if (!procs.some((q) => q.name === p.name && q.memMB === p.memMB)) procs.push(p);
  f.procs = procs;
  const swapTotal = (mem.SwapTotal || 0) / 1024;
  const swapUsed = swapTotal - (mem.SwapFree || 0) / 1024;
  f.memory = { swapMB: Math.round(swapTotal), swapUsedMB: Math.round(swapUsed) };
  const df = (k) =>
    (s[k] || [])
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 6 && /^\d+$/.test(c[1]));
  f.disks = df("df").map((c) => ({ mount: c[5], device: c[0], totalGB: Math.round(+c[1] / 1048576 * 100) / 100, freeGB: Math.round(+c[3] / 1048576 * 100) / 100 }));
  const inodes = {};
  for (const c of df("dfi")) if (+c[1] > 0) inodes[c[5]] = Math.round((100 * +c[2]) / +c[1]);
  for (const d of f.disks) if (inodes[d.mount] != null) d.inodesUsedPct = inodes[d.mount];
  const psi = {};
  for (const l of s.psi || []) {
    const m = l.match(/^(\w+)\s+some avg10=([\d.]+)/);
    if (m) psi[m[1]] = +m[2];
  }
  f.pressure = psi;
  f.events = {
    days: 7,
    oomKills: num(first("oom")) || 0,
    ioErrors: num(first("ioerr")) || 0,
    topErrors: (s.errors || []).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\d+)\s+(.*)$/);
      return m ? { count: +m[1], text: m[2].slice(0, 200) } : { count: 1, text: l.slice(0, 200) };
    }),
    failedUnits: (s.failed || []).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
  };
  f.thermal = (s.thermal || []).map(num).filter((x) => x != null).map((x) => Math.round(x / 1000));
  f.pendingReboot = first("reboot") === "yes";
  f.zombies = num(first("zombies")) || 0;
  f.dstate = (s.dstate || []).map((l) => l.trim()).filter(Boolean);
  const ping = (s.ping || []).join(" ");
  const loss = ping.match(/([\d.]+)% packet loss/);
  const rtt = ping.match(/= [\d.]+\/([\d.]+)\/([\d.]+)/);
  f.network = { dnsMs: num(first("dns")), pingMs: rtt ? Math.round(+rtt[1]) : null, pingMaxMs: rtt ? Math.round(+rtt[2]) : null, lossPct: loss ? Math.round(+loss[1]) : null };
  f.docker = (s.docker || []).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { name: l.slice(0, i), status: l.slice(i + 1) };
  });
  return f;
}

module.exports = { collect, sshHosts, checkTarget, parseLinux, parseWindows, run, ssh, SSH_OPTS };
