"use strict";

// Fast, read-only checks for the Health page: the SSH hosts and keys in
// ~/.ssh, a few-second check of each host, and this computer's CPU, memory
// and disks right now. The full collector (collect.js) takes a minute; these
// take a second or two. Every child process starts hidden.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { run } = require("./collect.js");

function sshDir(home) {
  return path.join(home || os.homedir(), ".ssh");
}

// The -F path for ssh. ProxyJump starts a second ssh with the same -F, and
// that one drops backslashes, so on Windows the path uses forward slashes.
function sshConfigArg(home) {
  return path.join(sshDir(home), "config").replace(/\\/g, "/");
}

function expand(p, home) {
  const h = home || os.homedir();
  return path.resolve(String(p).replace(/^["']|["']$/g, "").replace(/^~(?=$|[\\/])/, h).replace(/%d/g, h));
}

// Named hosts from ~/.ssh/config with the settings the page shows. Wildcard
// blocks are skipped, but their IdentityFile lines still apply to the hosts
// they match (only "Host *" is handled, which covers most configs).
function sshConfig(home) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(sshDir(home), "config"), "utf8");
  } catch {
    return { hosts: [], defaults: {} };
  }
  const hosts = [];
  const defaults = { identityFiles: [] };
  let cur = [];
  let comment = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      comment = line.replace(/^#+\s*/, "");
      continue;
    }
    const m = line.match(/^(\S+?)\s*[=\s]\s*(.+)$/);
    if (!m) {
      if (!line) comment = "";
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host" || key === "match") {
      cur = [];
      if (key === "host") {
        for (const name of value.split(/\s+/)) {
          if (name === "*") cur.push(defaults);
          else if (!/[*?!]/.test(name)) {
            const host = { name, note: comment || "", hostname: "", user: "", port: "", via: "", identityFiles: [] };
            hosts.push(host);
            cur.push(host);
          }
        }
      }
      comment = "";
      continue;
    }
    for (const host of cur) {
      if (key === "identityfile") host.identityFiles.push(expand(value, home));
      else if (host === defaults) continue;
      else if (key === "hostname" && !host.hostname) host.hostname = value;
      else if (key === "user" && !host.user) host.user = value;
      else if (key === "port" && !host.port) host.port = value;
      else if (key === "proxyjump" && !host.via) host.via = value;
    }
  }
  for (const host of hosts) if (!host.identityFiles.length) host.identityFiles = defaults.identityFiles.slice();
  return { hosts, defaults };
}

function readU32(buf, at) {
  return buf.readUInt32BE(at);
}

function readStr(buf, at) {
  const n = readU32(buf, at);
  return { value: buf.subarray(at + 4, at + 4 + n), next: at + 4 + n };
}

// Key type, size and SHA256 fingerprint from an SSH public key blob.
function describeBlob(blob) {
  const type = readStr(blob, 0);
  const name = type.value.toString();
  let bits = null;
  if (name === "ssh-rsa") {
    const e = readStr(blob, type.next);
    let n = readStr(blob, e.next).value;
    while (n.length && n[0] === 0) n = n.subarray(1);
    bits = n.length * 8;
  } else if (name === "ssh-ed25519") bits = 256;
  else if (name.startsWith("ecdsa-sha2-nistp")) bits = Number(name.slice(16)) || null;
  else if (name === "ssh-dss") bits = 1024;
  const kind = name === "ssh-ed25519" ? "Ed25519" : name === "ssh-rsa" ? "RSA" : name.startsWith("ecdsa") ? "ECDSA" : name === "ssh-dss" ? "DSA" : name.replace(/^ssh-/, "");
  return { type: kind, bits, fingerprint: "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "") };
}

function parsePrivate(text) {
  const out = { format: "", passphrase: null, blob: null };
  if (/BEGIN OPENSSH PRIVATE KEY/.test(text)) {
    out.format = "OpenSSH";
    try {
      const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      const buf = Buffer.from(b64, "base64");
      const magic = "openssh-key-v1\0";
      if (buf.subarray(0, magic.length).toString("latin1") !== magic) return out;
      let at = magic.length;
      const cipher = readStr(buf, at);
      at = readStr(buf, cipher.next).next; // kdf name
      at = readStr(buf, at).next; // kdf options
      at += 4; // key count
      out.passphrase = cipher.value.toString() !== "none";
      out.blob = readStr(buf, at).value;
    } catch {
      // Unreadable key body: report the format only.
    }
  } else if (/BEGIN (RSA|EC|DSA) PRIVATE KEY/.test(text)) {
    out.format = "PEM";
    out.passphrase = /Proc-Type:\s*4,ENCRYPTED/.test(text);
  } else if (/BEGIN ENCRYPTED PRIVATE KEY/.test(text)) {
    out.format = "PKCS#8";
    out.passphrase = true;
  } else if (/BEGIN PRIVATE KEY/.test(text)) {
    out.format = "PKCS#8";
    out.passphrase = false;
  }
  return out;
}

function looksPrivate(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 20000) return false;
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fs.readFileSync(file, "utf8").slice(0, 200));
  } catch {
    return false;
  }
}

// Windows OpenSSH refuses a private key that other users can read.
async function windowsOpenToOthers(file) {
  if (process.platform !== "win32") return null;
  const r = await run("icacls.exe", [file], "", 10000);
  if (r.code !== 0) return null;
  const wide = r.out.split(/\r?\n/).filter((l) => /\\Users:|Everyone:|Authenticated Users:/i.test(l));
  return wide.length ? wide.map((l) => l.replace(file, "").trim()).join(", ") : "";
}

function posixOpenToOthers(file) {
  if (process.platform === "win32") return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    return mode & 0o077 ? "mode " + mode.toString(8) : "";
  } catch {
    return null;
  }
}

async function keyInfo(file, usedBy) {
  const info = { path: file, name: path.basename(file), exists: false, usedBy, problems: [] };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
    info.exists = true;
  } catch {
    info.problems.push({ level: "problem", text: "The key file is missing. " + (usedBy.length ? names(usedBy) + " cannot log in with it." : "") });
    return info;
  }
  const priv = parsePrivate(text);
  info.format = priv.format;
  info.passphrase = priv.passphrase;
  let blob = priv.blob;
  let comment = "";
  try {
    const pub = fs.readFileSync(file + ".pub", "utf8").trim().split(/\s+/);
    info.hasPub = true;
    comment = pub.slice(2).join(" ");
    if (!blob && pub[1]) blob = Buffer.from(pub[1], "base64");
  } catch {
    info.hasPub = false;
  }
  info.comment = comment;
  if (blob) {
    try {
      Object.assign(info, describeBlob(blob));
    } catch {
      // Leave type unknown.
    }
  }
  try {
    info.modified = fs.statSync(file).mtimeMs;
  } catch {
    // ignore
  }
  const open = process.platform === "win32" ? await windowsOpenToOthers(file) : posixOpenToOthers(file);
  if (open) info.problems.push({ level: "problem", text: "Other users on this computer can read it (" + open + "). SSH refuses keys like this." });
  if (info.type === "DSA") info.problems.push({ level: "problem", text: "DSA keys are turned off in current OpenSSH. Make an Ed25519 key." });
  else if (info.type === "RSA" && info.bits && info.bits < 2048) info.problems.push({ level: "problem", text: "RSA " + info.bits + " is too short. Make an Ed25519 key." });
  else if (info.type === "RSA" && info.bits && info.bits < 3072) info.problems.push({ level: "warning", text: "RSA " + info.bits + " is weaker than current advice (3072+ or Ed25519)." });
  if (!info.hasPub) info.problems.push({ level: "info", text: "No matching .pub file next to it." });
  if (!usedBy.length) info.problems.push({ level: "info", text: "No host in ~/.ssh/config uses this key." });
  return info;
}

function names(list) {
  return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0] || "";
}

// Hosts from ~/.ssh/config and every private key in ~/.ssh or used by a host.
async function sshInventory(home) {
  const { hosts } = sshConfig(home);
  const dir = sshDir(home);
  const files = new Map();
  const add = (f) => {
    const key = process.platform === "win32" ? f.toLowerCase() : f;
    if (!files.has(key)) files.set(key, f);
  };
  for (const h of hosts) h.identityFiles.forEach(add);
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (!/\.pub$|^known_hosts|^config$|^authorized_keys/.test(n) && looksPrivate(f)) add(f);
    }
  } catch {
    // No ~/.ssh folder.
  }
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keys = await Promise.all(
    [...files.values()].map((f) => keyInfo(f, hosts.filter((h) => h.identityFiles.some((x) => same(x, f))).map((h) => h.name))),
  );
  keys.sort((a, b) => b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name));
  return { configPath: path.join(dir, "config"), hosts, keys };
}

// Small read-only script for a Linux host: OS, uptime, CPU, memory, disks,
// failed services and pending reboot. Runs in a second or two.
const HOST_SH = [
  // apt's "upgradable" and "Inst" lines are matched below, so its messages
  // must not be translated.
  "export LC_ALL=C LANG=C",
  "echo \"os=$( (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -s)\"",
  "echo \"kernel=$(uname -r)\"",
  "echo \"host=$(hostname)\"",
  "echo \"up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)\"",
  "echo \"load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"",
  "echo \"cpus=$(nproc 2>/dev/null)\"",
  "echo \"stat1=$(head -1 /proc/stat 2>/dev/null)\"; sleep 1; echo \"stat2=$(head -1 /proc/stat 2>/dev/null)\"",
  "awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}/^SwapTotal/{st=$2}/^SwapFree/{sf=$2}END{print \"mem=\"t\" \"a\" \"st\" \"sf}' /proc/meminfo 2>/dev/null",
  "df -Pk -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk 'NR>1{print \"disk=\"$2\" \"$4\" \"$6}'",
  "echo \"failed=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\\n' ' ')\"",
  "echo \"reboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)\"",
  "echo \"docker=$(docker ps -q 2>/dev/null | wc -l) $(docker ps -aq -f status=exited -f status=dead 2>/dev/null | wc -l)\"",
  // Pending package updates, from the package lists already on the host (no download).
  "if [ \"$(id -u)\" = 0 ]; then echo root=yes; elif sudo -n true 2>/dev/null; then echo root=sudo; else echo root=no; fi",
  "if command -v apt-get >/dev/null 2>&1; then echo pm=apt; L=$(apt list --upgradable 2>/dev/null | grep upgradable); " +
    "echo \"upd=$(printf '%s' \"$L\" | grep -c .)\"; echo \"sec=$(printf '%s' \"$L\" | grep -c -- -security)\"; " +
    "echo \"pkgs=$(printf '%s' \"$L\" | cut -d/ -f1 | head -60 | tr '\\n' ' ')\"; echo \"listed=$(stat -c %Y /var/lib/apt/lists/partial 2>/dev/null)\"; " +
    "elif command -v dnf >/dev/null 2>&1; then echo pm=dnf; L=$(dnf -q -C check-update 2>/dev/null | awk 'NF==3{print $1}'); " +
    "echo \"upd=$(printf '%s' \"$L\" | grep -c .)\"; echo \"pkgs=$(printf '%s' \"$L\" | head -60 | tr '\\n' ' ')\"; fi",
  // Last line: a check cut off part way is reported as failed, not healthy.
  "echo jmcp_done=1",
].join("\n") + "\n";

function parseHost(out) {
  const v = {};
  const disks = [];
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const val = line.slice(i + 1).trim();
    if (k === "disk") disks.push(val);
    else v[k] = val;
  }
  const r = { os: v.os || "", kernel: v.kernel || "", hostname: v.host || "" };
  if (v.up) r.uptimeSec = Math.round(Number(v.up));
  r.cpus = Number(v.cpus) || null;
  if (v.load) {
    r.load = v.load.split(/\s+/).map(Number);
    if (r.cpus) r.loadPct = Math.round((100 * r.load[0]) / r.cpus);
  }
  // /proc/stat: user nice system idle iowait irq softirq steal guest
  // guest_nice. guest and guest_nice are already counted in user and nice.
  const ticks = (s) => (s || "").split(/\s+/).slice(1, 9).map(Number);
  const a = ticks(v.stat1);
  const b = ticks(v.stat2);
  if (a.length >= 4 && b.length >= 4) {
    const total = b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0);
    const idle = b[3] + (b[4] || 0) - (a[3] + (a[4] || 0));
    if (total > 0) r.cpuPct = Math.max(0, Math.min(100, Math.round((100 * (total - idle)) / total)));
  }
  if (v.mem) {
    const [t, av, st, sf] = v.mem.split(/\s+/).map(Number);
    if (t) r.memory = { totalMB: Math.round(t / 1024), usedPct: Math.round(100 * (1 - av / t)) };
    if (st) r.swap = { totalMB: Math.round(st / 1024), usedPct: Math.round(100 * (1 - sf / st)) };
  }
  r.disks = disks
    .map((d) => {
      const [total, free, mount] = d.split(/\s+/);
      const t = Number(total);
      return { mount, totalGB: Math.round(t / 1048576 * 10) / 10, freeGB: Math.round(Number(free) / 1048576 * 10) / 10, usedPct: t ? Math.round(100 * (1 - Number(free) / t)) : null };
    })
    // Small partitions count too: a full /boot blocks kernel updates.
    .filter((d) => d.mount && d.totalGB >= 0.05);
  r.failed = (v.failed || "").split(/\s+/).filter(Boolean);
  r.rebootNeeded = v.reboot === "yes";
  if (v.docker) {
    const [running, stopped] = v.docker.split(/\s+/).map(Number);
    if (running || stopped) r.containers = { running, stopped };
  }
  r.root = v.root || "";
  if (v.pm) {
    r.updates = {
      manager: v.pm,
      count: Number(v.upd) || 0,
      security: Number(v.sec) || 0,
      packages: (v.pkgs || "").split(/\s+/).filter(Boolean),
      listedAt: Number(v.listed) ? Number(v.listed) * 1000 : null,
      canApply: v.root === "yes" || v.root === "sudo",
    };
  }
  return r;
}

function hostProblems(r) {
  const p = [];
  for (const d of r.disks || []) {
    if (d.usedPct >= 95) p.push({ level: "problem", text: d.mount + " is " + d.usedPct + "% full (" + d.freeGB + " GB free)." });
    else if (d.usedPct >= 85) p.push({ level: "warning", text: d.mount + " is " + d.usedPct + "% full (" + d.freeGB + " GB free)." });
  }
  if (r.memory && r.memory.usedPct >= 92) p.push({ level: "problem", text: "Memory is " + r.memory.usedPct + "% used." });
  else if (r.memory && r.memory.usedPct >= 80) p.push({ level: "warning", text: "Memory is " + r.memory.usedPct + "% used." });
  if (r.swap && r.swap.usedPct >= 50) p.push({ level: "warning", text: "Swap is " + r.swap.usedPct + "% used, so the host is short on memory." });
  if (r.loadPct >= 150) p.push({ level: "problem", text: "Load is " + r.load[0] + " on " + r.cpus + " CPUs." });
  else if (r.loadPct >= 90) p.push({ level: "warning", text: "Load is " + r.load[0] + " on " + r.cpus + " CPUs." });
  if (r.failed && r.failed.length) p.push({ level: "problem", text: r.failed.length + " failed " + (r.failed.length === 1 ? "service" : "services") + ": " + r.failed.slice(0, 4).join(", ") + (r.failed.length > 4 ? "…" : "") + "." });
  if (r.updates && r.updates.security) p.push({ level: "warning", text: r.updates.security + " security " + (r.updates.security === 1 ? "update is" : "updates are") + " waiting." });
  if (r.rebootNeeded) p.push({ level: "warning", text: "Updates are waiting for a reboot." });
  return p;
}

function sshError(err) {
  const e = err.trim();
  if (/Permission denied/i.test(e)) return "The server turned down the key (Permission denied). Check that its public key is in authorized_keys on the server.";
  if (/Could not resolve/i.test(e)) return "The host name could not be found (DNS).";
  if (/timed out/i.test(e)) return "No answer before the time limit. The server may be down, or a firewall blocks port 22.";
  if (/Connection refused/i.test(e)) return "The server refused the connection. SSH may not be running there.";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) return "The server's host key does not match known_hosts. If the server was rebuilt, remove its old line from known_hosts; otherwise do not connect.";
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(e)) return "SSH refused the key because other users can read it.";
  if (/passphrase|incorrect passphrase/i.test(e)) return "The key needs a passphrase. Add it to ssh-agent so checks can use it.";
  return e.split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || "SSH failed with no message.";
}

// Log in with BatchMode (keys only, never a prompt) and read the host's state.
async function checkHost(name, home, timeoutMs) {
  const alias = String(name || "");
  if (!/^[\w.@:\-]+$/.test(alias) || alias.startsWith("-")) throw new Error("Bad host name " + JSON.stringify(alias) + ".");
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
  if (home) args.push("-F", sshConfigArg(home));
  args.push("-T", alias, "sh -s");
  const started = Date.now();
  const r = await run("ssh", args, HOST_SH, timeoutMs || 25000);
  const ms = Date.now() - started;
  if (!/^jmcp_done=1\r?$/m.test(r.out)) {
    if (!/os=/.test(r.out)) return { name: alias, ok: false, checkedAt: Date.now(), ms, error: sshError(r.err || (r.code === -1 ? "timed out" : "")) };
    const last = (r.err || "").trim().split(/\r?\n/).pop() || "";
    return { name: alias, ok: false, checkedAt: Date.now(), ms, error: "The check stopped part way" + (r.code === -1 ? " (timed out)" : " (exit " + r.code + ")") + ", so its results are not shown." + (last ? " " + last : "") };
  }
  const facts = parseHost(r.out);
  return Object.assign({ name: alias, ok: true, checkedAt: Date.now(), ms }, facts, { problems: hostProblems(facts) });
}

// ---- This computer, right now ----

function cpuTimes() {
  return os.cpus().reduce((t, c) => {
    const s = c.times;
    t.idle += s.idle;
    t.total += s.user + s.nice + s.sys + s.idle + s.irq;
    return t;
  }, { idle: 0, total: 0 });
}

function localDisks() {
  const list = [];
  const mounts = process.platform === "win32" ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => l + ":\\") : ["/", os.homedir()];
  const seen = new Set();
  for (const m of mounts) {
    try {
      if (process.platform === "win32" && !fs.existsSync(m)) continue;
      const s = fs.statfsSync(m);
      const total = s.blocks * s.bsize;
      if (!total || total < 1e9) continue;
      const id = s.blocks + ":" + s.bfree;
      if (seen.has(id)) continue;
      seen.add(id);
      const free = s.bavail * s.bsize;
      list.push({ mount: m.replace(/\\$/, ""), totalGB: Math.round(total / 1073741824 * 10) / 10, freeGB: Math.round(free / 1073741824 * 10) / 10, usedPct: Math.round(100 * (1 - free / total)) });
    } catch {
      // Drive not ready (card reader, disconnected network drive).
    }
  }
  return list;
}

// Biggest memory users. Windows reads the private working set, like Task Manager.
async function topProcesses() {
  if (process.platform === "win32") {
    const ps = "Get-Process | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{n=$_.Name; c=$_.Count; m=($_.Group | Measure-Object WorkingSet64 -Sum).Sum} } | Sort-Object m -Descending | Select-Object -First 6 | ConvertTo-Json -Compress";
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], "", 15000);
    try {
      const list = [].concat(JSON.parse(r.out));
      return list.map((p) => ({ name: p.n, count: p.c, memMB: Math.round(p.m / 1048576) }));
    } catch {
      return [];
    }
  }
  const r = await run("ps", ["-eo", "comm=,rss=", "--sort=-rss"], "", 10000);
  const sums = new Map();
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(.*\S)\s+(\d+)$/);
    if (!m) continue;
    const e = sums.get(m[1]) || { name: m[1], count: 0, memMB: 0 };
    e.count++;
    e.memMB += Math.round(Number(m[2]) / 1024);
    sums.set(m[1], e);
  }
  return [...sums.values()].sort((a, b) => b.memMB - a.memMB).slice(0, 6);
}

function localProblems(r) {
  const p = [];
  if (r.cpuPct >= 90) p.push({ level: "problem", text: "CPU is " + r.cpuPct + "% busy." });
  else if (r.cpuPct >= 70) p.push({ level: "warning", text: "CPU is " + r.cpuPct + "% busy." });
  if (r.memory.usedPct >= 92) p.push({ level: "problem", text: "Memory is " + r.memory.usedPct + "% used. Apps will slow down or stutter." });
  else if (r.memory.usedPct >= 80) p.push({ level: "warning", text: "Memory is " + r.memory.usedPct + "% used." });
  for (const d of r.disks) {
    if (d.usedPct >= 95) p.push({ level: "problem", text: d.mount + " is " + d.usedPct + "% full (" + d.freeGB + " GB free)." });
    else if (d.usedPct >= 85) p.push({ level: "warning", text: d.mount + " is " + d.usedPct + "% full (" + d.freeGB + " GB free)." });
  }
  return p;
}

async function localNow(opts) {
  const a = cpuTimes();
  const procs = opts && opts.processes === false ? Promise.resolve(null) : topProcesses();
  await new Promise((r) => setTimeout(r, 700));
  const b = cpuTimes();
  const total = b.total - a.total;
  const out = {
    hostname: os.hostname(),
    os: (os.version ? os.version() : os.type()) + "",
    uptimeSec: Math.round(os.uptime()),
    cpu: { model: (os.cpus()[0] || {}).model ? os.cpus()[0].model.trim() : "", threads: os.cpus().length },
    cpuPct: total > 0 ? Math.round((100 * (total - (b.idle - a.idle))) / total) : null,
    memory: { totalMB: Math.round(os.totalmem() / 1048576), usedPct: Math.round(100 * (1 - os.freemem() / os.totalmem())) },
    disks: localDisks(),
    checkedAt: Date.now(),
  };
  out.processes = await procs;
  out.problems = localProblems(out);
  return out;
}

// Install pending package updates on a host: apt-get upgrade (or dnf
// upgrade) as root or with passwordless sudo. Keeps current config files,
// never removes packages and never reboots. simulate: list what would be
// installed and change nothing.
function updateScript(simulate) {
  return [
    "set -e",
    "export LC_ALL=C LANG=C",
    "if [ \"$(id -u)\" = 0 ]; then S=''; elif sudo -n true 2>/dev/null; then S='sudo -n'; else echo 'JMCP: this login is not root and has no passwordless sudo.' >&2; exit 3; fi",
    // Proxmox hosts must use dist-upgrade (its kernels come in as new packages).
    // Elsewhere --with-new-pkgs installs updates that pull in a new package
    // (Ubuntu kernels) instead of keeping them back, still removing nothing.
    "if command -v pveversion >/dev/null 2>&1; then M=dist-upgrade; else M='upgrade --with-new-pkgs'; fi",
    // Ubuntu holds back phased updates that apt list --upgradable still shows,
    // so without this they never clear from the count.
    // --no-remove makes apt stop instead of removing anything to solve a conflict.
    "P='--no-remove -o APT::Get::Always-Include-Phased-Updates=true'",
    "if command -v apt-get >/dev/null 2>&1; then",
    simulate
      ? "  apt-get -s -q $P $M </dev/null"
      : "  $S apt-get update -q </dev/null\n  $S env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y -q $P -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold $M </dev/null",
    "elif command -v dnf >/dev/null 2>&1; then",
    // dnf -q prints no summary, so count changed packages from rpm before and
    // after. obsoletes=0 and installonly_limit=0 stop dnf removing replaced
    // packages and old kernels, so like apt it removes nothing.
    "  D='--setopt=obsoletes=0 --setopt=installonly_limit=0'",
    simulate
      // --assumeno always exits non-zero, so a failed resolve shows as Error lines.
      ? "  O=$(dnf -C $D --assumeno upgrade </dev/null 2>&1) || true\n" +
        "  if printf '%s\\n' \"$O\" | grep -q '^Error'; then printf '%s\\n' \"$O\" | grep -A5 '^Error' | sed 's/^/JMCP: /' >&2; exit 5; fi\n" +
        "  printf '%s\\n' \"$O\" | awk '/^(Upgrading|Installing)/{on=1;next} /^[A-Z]/{on=0} on&&NF==1{n=$1;next} on&&NF>=4{print \"Plan \" (n?n:$1); n=\"\"}'"
      : "  T=$(mktemp)\n  rpm -qa | sort > \"$T\"\n  $S dnf -y -q $D upgrade </dev/null\n  echo \"JMCP_CHANGED=$(rpm -qa | sort | comm -13 \"$T\" - | wc -l)\"\n  rm -f \"$T\"",
    "else echo 'JMCP: no apt-get or dnf on this host.' >&2; exit 4; fi",
    "echo \"JMCP_DONE reboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)\"",
  ].join("\n") + "\n";
}

async function applyUpdates(name, home, opts) {
  const alias = String(name || "");
  if (!/^[\w.@:\-]+$/.test(alias) || alias.startsWith("-")) throw new Error("Bad host name " + JSON.stringify(alias) + ".");
  const simulate = Boolean(opts && opts.simulate);
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"];
  if (home) args.push("-F", sshConfigArg(home));
  // The script travels as base64 in the command, so apt and dpkg never read
  // the rest of it from stdin.
  const b64 = Buffer.from(updateScript(simulate)).toString("base64");
  args.push("-T", alias, "sh -c \"$(echo " + b64 + " | base64 -d)\"");
  const started = Date.now();
  const r = await run("ssh", args, "", (opts && opts.timeoutMs) || 20 * 60000);
  const log = (r.out + (r.err ? "\n" + r.err : "")).trim();
  const tail = log.split(/\r?\n/).filter((l) => l.trim() && !/^JMCP_DONE/.test(l)).slice(-40).join("\n");
  const done = r.out.match(/JMCP_DONE reboot=(yes|no)/);
  if (!done) {
    const why = (log.match(/^JMCP: .*$/gm) || []).map((l) => l.slice(6).trim()).filter(Boolean).join(" ");
    return { name: alias, ok: false, simulate, ms: Date.now() - started, error: why ? why : r.code === -1 ? "Timed out after " + Math.round(((opts && opts.timeoutMs) || 1200000) / 60000) + " minutes." : sshError(r.err || "exit " + r.code), log: tail };
  }
  const counted = r.out.match(/(\d+) upgraded, (\d+) newly installed/);
  const changed = r.out.match(/^JMCP_CHANGED=\s*(\d+)/m);
  const installed = counted ? Number(counted[1]) + Number(counted[2]) : changed ? Number(changed[1]) : (r.out.match(/^(Inst|Setting up) /gm) || []).length;
  // Every package a dry run would install, from the whole output, not the
  // shortened log.
  const planned = simulate ? (r.out.match(/^(?:Inst|Plan) \S+/gm) || []).map((l) => l.slice(5)) : undefined;
  return { name: alias, ok: true, simulate, ms: Date.now() - started, rebootNeeded: done[1] === "yes", installed, planned, log: tail };
}

module.exports = { sshConfig, sshInventory, keyInfo, checkHost, applyUpdates, updateScript, parseHost, hostProblems, localNow, describeBlob, parsePrivate, HOST_SH };
