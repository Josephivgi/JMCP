"use strict";

// Health page: notes agents left for the user, this computer right now, the
// SSH servers in ~/.ssh/config and the keys they use. Loaded after app.js and
// uses its helpers (h, head, icon, render, ago, api, page, serverStrip, names).

const hl = {
  notes: null, notesError: "", showDismissed: false, noteAsk: "", noteBusy: false,
  local: null, localError: "", localLoading: false,
  ssh: null, sshError: "", sshLoading: false,
  hosts: new Map(), // name -> {checking} | result
  full: new Map(), // target -> {checking, started} | {result} | {error}
  open: new Set(), // open <details> keys, kept across re-renders
  upd: new Map(), // host -> {asking} | {running, started} | {result}
  updAllAsk: false,
  updBatch: false,
  timer: null, ticks: 0, started: false,
};

const LEVEL = {
  problem: { label: "Problem", cls: "bad", icon: WARN },
  warning: { label: "Warning", cls: "warn", icon: WARN },
  good: { label: "Good", cls: "ok", icon: CHECK },
  info: { label: "Note", cls: "", icon: "M10 9v5M10 6v.5M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" },
};
const SEV = { high: "problem", medium: "warning", low: "info", info: "info" };

function uptime(sec) {
  if (sec == null) return "";
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  return d ? d + "d " + hrs + "h" : hrs + "h " + Math.floor((sec % 3600) / 60) + "m";
}

function gb(mb) {
  return mb >= 1024 ? Math.round(mb / 102.4) / 10 + " GB" : mb + " MB";
}

function band(pct, warnAt, badAt) {
  return pct == null ? "" : pct >= badAt ? "bad" : pct >= warnAt ? "warn" : "ok";
}

function gauge(label, pct, detail, warnAt, badAt) {
  const cls = band(pct, warnAt || 80, badAt || 92);
  // The page's CSP blocks style attributes; set the width through CSSOM.
  const fill = h("span", { class: "gauge-fill" });
  fill.style.width = Math.max(2, Math.min(100, pct || 0)) + "%";
  return h("div", { class: "gauge " + cls },
    h("div", { class: "gauge-top" }, h("span", { class: "gauge-label", text: label }), h("span", { class: "gauge-val", text: pct == null ? "?" : pct + "%" })),
    h("div", { class: "gauge-bar", role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct == null ? null : String(pct) },
      fill),
    detail ? h("span", { class: "gauge-detail", text: detail }) : null,
  );
}

function issueList(list) {
  if (!list || !list.length) return null;
  return h("ul", { class: "hl-issues" }, list.map((p) => {
    const l = LEVEL[p.level] || LEVEL.info;
    return h("li", { class: "hl-issue " + l.cls }, icon(l.icon), h("span", { text: p.text }));
  }));
}

function keep(key, el) {
  if (hl.open.has(key)) el.open = true;
  el.addEventListener("toggle", () => (el.open ? hl.open.add(key) : hl.open.delete(key)));
  return el;
}

// ---- Loading ----

async function loadNotes() {
  try {
    const list = await api.health.notes({ dismissed: true });
    const changed = JSON.stringify(list) !== JSON.stringify(hl.notes);
    hl.notes = list;
    hl.notesError = "";
    return changed;
  } catch (e) {
    const changed = hl.notesError !== e.message;
    hl.notesError = e.message;
    return changed;
  }
}

async function loadLocal() {
  if (hl.localLoading) return;
  hl.localLoading = true;
  try {
    hl.local = await api.health.local();
    hl.localError = "";
  } catch (e) {
    hl.localError = e.message;
  }
  hl.localLoading = false;
}

async function loadSsh() {
  hl.sshLoading = true;
  render();
  try {
    hl.ssh = await api.health.ssh();
    hl.sshError = "";
  } catch (e) {
    hl.sshError = e.message;
  }
  hl.sshLoading = false;
  render();
}

async function checkHost(name) {
  const cur = hl.hosts.get(name);
  if (cur && cur.checking) return;
  hl.hosts.set(name, Object.assign({}, cur, { checking: true }));
  render();
  try {
    hl.hosts.set(name, await api.health.host(name));
  } catch (e) {
    hl.hosts.set(name, { name, ok: false, error: e.message, checkedAt: Date.now() });
  }
  render();
}

function checkAllHosts() {
  if (!hl.ssh) return;
  for (const host of hl.ssh.hosts) checkHost(host.name);
}

async function fullCheck(target) {
  const cur = hl.full.get(target);
  if (cur && cur.checking) return;
  hl.full.set(target, { checking: true, started: Date.now() });
  hl.open.add("full-" + target);
  render();
  try {
    hl.full.set(target, { result: await api.health.full(target) });
  } catch (e) {
    hl.full.set(target, { error: e.message });
  }
  render();
}

async function checkEverything() {
  loadLocal().then(render);
  if (!hl.ssh) await loadSsh();
  checkAllHosts();
  loadSsh();
}

function startHealth() {
  if (hl.started) return;
  hl.started = true;
  loadNotes().then(render);
  loadLocal().then(render);
  loadSsh().then(checkAllHosts);
}

// Notes refresh every 5 seconds so the sidebar count stays right; this
// computer refreshes too while the Health page is open.
function newNotes() {
  return hl.notes ? hl.notes.filter((n) => !n.dismissedAt).length : 0;
}

setInterval(async () => {
  if (document.hidden || !st) return;
  const changed = await loadNotes();
  if (page === "health" && hl.started) {
    await loadLocal();
    if (page === "health") return render();
  }
  if (changed) render();
}, 5000);
setTimeout(() => loadNotes().then((changed) => changed && st && render()), 300);

// ---- Notes from agents ----

async function noteWork(work) {
  if (hl.noteBusy) return;
  hl.noteBusy = true;
  render();
  try {
    await work();
    hl.notesError = "";
  } catch (e) {
    hl.notesError = e.message;
  }
  hl.noteAsk = "";
  await loadNotes();
  hl.noteBusy = false;
  render();
}

function noteCard(n) {
  const l = LEVEL[n.level] || LEVEL.info;
  const asking = hl.noteAsk === n.id;
  return h("article", { class: "note " + l.cls + (n.dismissedAt ? " gone" : "") },
    h("span", { class: "note-icon" }, icon(l.icon)),
    h("div", { class: "note-main" },
      h("div", { class: "note-head" },
        h("h3", { class: "note-title", text: n.title }),
        h("span", { class: "pill " + l.cls, text: l.label }),
      ),
      n.body ? h("p", { class: "note-body", text: n.body }) : null,
      h("p", { class: "note-meta" },
        h("span", { text: "From " + n.author }),
        n.about ? h("span", { text: "About " + n.about }) : null,
        h("span", { title: new Date(n.createdAt).toLocaleString(), text: ago(n.createdAt) }),
      ),
    ),
    h("div", { class: "note-actions" },
      n.dismissedAt
        ? asking
          ? h("div", { class: "row-actions", role: "alertdialog", "aria-label": "Delete note", onkeydown: (e) => { if (e.key === "Escape") { hl.noteAsk = ""; render(); focusLater("note-del-" + n.id); } } },
            h("button", { class: "btn small danger", disabled: hl.noteBusy, onclick: () => noteWork(() => api.health.remove(n.id)) }, "Delete"),
            h("button", { class: "btn small", "data-focus-key": "note-del-cancel-" + n.id, onclick: () => { hl.noteAsk = ""; render(); focusLater("note-del-" + n.id); } }, "Cancel"))
          : [
            h("button", { class: "btn small", disabled: hl.noteBusy, onclick: () => noteWork(() => api.health.dismiss(n.id, true)) }, "Bring back"),
            h("button", { class: "btn small quiet danger", disabled: hl.noteBusy, "data-focus-key": "note-del-" + n.id, onclick: () => { hl.noteAsk = n.id; render(); focusLater("note-del-cancel-" + n.id); } }, "Delete"),
          ]
        : h("button", { class: "btn small", disabled: hl.noteBusy, "aria-label": "Dismiss " + n.title, onclick: () => noteWork(() => api.health.dismiss(n.id)) }, "Dismiss"),
    ),
  );
}

function notesSection() {
  const list = hl.notes || [];
  const active = list.filter((n) => !n.dismissedAt);
  const gone = list.filter((n) => n.dismissedAt);
  const shown = hl.showDismissed ? gone : active;
  return h("section", { class: "hl-section", "aria-labelledby": "hl-notes" },
    h("div", { class: "hl-section-head" },
      h("div", {},
        h("h2", { id: "hl-notes" }, "From your agents", active.length ? h("span", { class: "count-badge", text: String(active.length) }) : null),
        h("p", { class: "hint", text: "Cards your agents left with jmcp-health's show_user tool. New ones show up here on their own." }),
      ),
      h("div", { class: "row-actions" },
        !hl.showDismissed && active.length > 1 ? h("button", { class: "btn small quiet", disabled: hl.noteBusy, onclick: () => noteWork(() => api.health.dismissAll()) }, "Dismiss all") : null,
        gone.length || hl.showDismissed ? h("button", { class: "btn small", "data-focus-key": "notes-toggle", onclick: () => { hl.showDismissed = !hl.showDismissed; hl.noteAsk = ""; render(); } }, hl.showDismissed ? "Back to new" : "Dismissed (" + gone.length + ")") : null,
      ),
    ),
    hl.notesError ? h("div", { class: "error-box", role: "alert", text: "Could not load notes: " + hl.notesError }) : null,
    !hl.notes && !hl.notesError ? h("div", { class: "panel empty", text: "Loading notes…" }) :
    !shown.length ? h("div", { class: "panel hl-empty" },
      h("p", { class: "hl-empty-title", text: hl.showDismissed ? "Nothing dismissed" : "Nothing new from your agents" }),
      hl.showDismissed ? null : h("p", { class: "hint", text: "Ask an agent to \"show me\" something, or to tell you when a long task finds a problem, and it lands here." }),
    ) :
    h("div", { class: "notes" }, shown.map(noteCard)),
  );
}

// ---- This computer ----

function fullView(target) {
  const f = hl.full.get(target);
  if (!f) return null;
  if (f.checking) {
    return h("div", { class: "hl-full running", role: "status" },
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("span", { text: "Full check running. It reads event logs, drivers, disks and the network, so it takes about a minute" + (f.started ? " (" + Math.round((Date.now() - f.started) / 1000) + "s so far)." : ".") }),
    );
  }
  if (f.error) return h("div", { class: "error-box", role: "alert", text: "Full check failed: " + f.error });
  const r = f.result;
  const bad = r.problems.filter((p) => p.severity === "high" || p.severity === "medium");
  return keep("full-" + target, h("details", { class: "hl-full" },
    h("summary", {},
      h("span", { class: "pill " + (bad.length ? "warn" : "ok") }, icon(bad.length ? WARN : CHECK), bad.length ? bad.length + " to look at" : "No problems"),
      h("span", { text: "Full check, " + r.problems.length + " " + (r.problems.length === 1 ? "finding" : "findings") + ", " + ago(r.checkedAt) }),
    ),
    r.problems.length ? h("ol", { class: "finds" }, r.problems.map((p, i) => {
      const l = LEVEL[SEV[p.severity]] || LEVEL.info;
      return keep("find-" + target + "-" + i, h("li", { class: "find " + l.cls },
        h("details", {},
          h("summary", {}, h("span", { class: "pill " + l.cls, text: p.severity === "high" ? "High" : p.severity === "medium" ? "Medium" : p.severity === "low" ? "Low" : "Info" }), h("span", { class: "find-title", text: p.title })),
          h("div", { class: "find-body" },
            p.evidence ? h("p", {}, h("b", { text: "Seen: " }), p.evidence) : null,
            p.why ? h("p", {}, h("b", { text: "Why it matters: " }), p.why) : null,
            p.fix ? h("p", {}, h("b", { text: "Fix: " }), p.fix) : null,
          ),
        ),
      ));
    })) : h("p", { class: "hint", text: "Nothing wrong was found." }),
  ));
}

function localSection() {
  const l = hl.local;
  const full = hl.full.get("local");
  return h("section", { class: "hl-section", "aria-labelledby": "hl-local" },
    h("div", { class: "hl-section-head" },
      h("div", {},
        h("h2", { id: "hl-local", text: "This computer" }),
        h("p", { class: "hint", text: l ? l.hostname + " · " + l.os + " · up " + uptime(l.uptimeSec) + " · updates every 5 seconds" : "CPU, memory and disks right now." }),
      ),
      h("button", { class: "btn small", disabled: Boolean(full && full.checking), title: "Event logs, drivers, GPU, disks, power and network. Read-only.", onclick: () => fullCheck("local") }, full && full.checking ? "Checking…" : "Full check"),
    ),
    hl.localError ? h("div", { class: "error-box", role: "alert", text: "Could not read this computer: " + hl.localError }) : null,
    !l ? (hl.localError ? null : h("div", { class: "panel empty", text: "Reading this computer…" })) :
    h("div", { class: "panel hl-local" },
      h("div", { class: "gauges" },
        gauge("CPU", l.cpuPct, l.cpu.threads + " threads" + (l.cpu.model ? " · " + l.cpu.model.replace(/ with .*$/, "") : ""), 70, 90),
        gauge("Memory", l.memory.usedPct, gb(Math.round((l.memory.totalMB * l.memory.usedPct) / 100)) + " of " + gb(l.memory.totalMB)),
        l.disks.map((d) => gauge("Disk " + d.mount, d.usedPct, d.freeGB + " GB free of " + d.totalGB, 85, 95)),
      ),
      issueList(l.problems.filter((p) => p.level === "problem")),
      l.processes && l.processes.length ? h("div", { class: "procs" },
        h("h3", { class: "procs-title", text: "Using the most memory" }),
        h("ol", { class: "proc-list" }, l.processes.map((p) => h("li", {},
          h("span", { class: "proc-name", text: p.name }),
          p.count > 1 ? h("span", { class: "proc-count", text: "×" + p.count }) : null,
          h("span", { class: "proc-mem", text: gb(p.memMB) }),
        ))),
      ) : null,
      fullView("local"),
    ),
  );
}

// ---- SSH servers ----

// Hosts whose last check found updates that this login can install.
function updatable() {
  if (!hl.ssh) return [];
  return hl.ssh.hosts.filter((x) => {
    const r = hl.hosts.get(x.name);
    const u = hl.upd.get(x.name);
    return r && r.ok && r.updates && r.updates.count > 0 && r.updates.canApply && !(u && (u.running || u.queued));
  });
}

async function applyUpdates(name) {
  const cur = hl.upd.get(name);
  if (cur && cur.running) return;
  hl.upd.set(name, { running: true, started: Date.now() });
  render();
  let result;
  try {
    result = await api.health.update(name);
  } catch (e) {
    result = { name, ok: false, error: e.message };
  }
  hl.upd.set(name, { result });
  render();
  await checkHost(name);
}

// One host at a time. Hosts other hosts jump through go last, so an update
// there does not cut off the others mid-way.
async function applyAll() {
  hl.updAllAsk = false;
  // One batch at a time: a second batch would update its hosts while the
  // first is mid-way, and jump hosts out of order.
  if (hl.updBatch) return;
  const list = updatable();
  const jumps = new Set(hl.ssh.hosts.map((x) => x.via).filter(Boolean));
  list.sort((a, b) => jumps.has(a.name) - jumps.has(b.name));
  for (const x of list) hl.upd.set(x.name, { queued: true });
  hl.updBatch = true;
  render();
  try {
    for (const x of list) await applyUpdates(x.name);
  } finally {
    hl.updBatch = false;
    render();
  }
}

function updatesBlock(host, r) {
  const u = r.updates;
  const st8 = hl.upd.get(host.name) || {};
  if (st8.running) {
    return h("div", { class: "upd running", role: "status" },
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("span", { text: "Installing updates… " + Math.round((Date.now() - st8.started) / 1000) + "s. Updated services restart on their own." }),
    );
  }
  if (st8.queued) return h("div", { class: "upd running", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { text: "Waiting for the other servers to finish…" }));
  const res = st8.result;
  const resView = res ? h("div", { class: res.ok ? "ok-box upd-result" : "error-box upd-result", role: res.ok ? "status" : "alert" },
    h("div", { class: "upd-result-text" },
      h("p", { class: "box-title", text: res.ok ? (res.installed ? "Installed " + res.installed + (res.installed === 1 ? " update" : " updates") : "Nothing needed installing") + " in " + Math.max(1, Math.round(res.ms / 1000)) + "s." : "Updates failed: " + res.error }),
      res.ok && res.rebootNeeded ? h("p", { text: "Reboot the server to finish. JMCP does not reboot it for you." }) : null,
      res.log ? keep("updlog-" + host.name, h("details", { class: "upd-log" }, h("summary", { text: "Show output" }), h("pre", { text: res.log }))) : null,
    ),
    h("button", { class: "btn small quiet", "aria-label": "Dismiss update result for " + host.name, onclick: () => { hl.upd.delete(host.name); render(); } }, "Dismiss"),
  ) : null;
  if (!u) return resView;
  if (!u.count) return resView || h("p", { class: "upd-none" }, icon(CHECK), "No updates waiting");
  const tool = u.manager === "dnf" ? "dnf upgrade" : /Proxmox|pve/i.test(r.kernel + " " + (host.note || "")) ? "apt-get dist-upgrade" : "apt-get upgrade";
  return h("div", { class: "upd" },
    resView,
    h("div", { class: "upd-row" },
      h("span", { class: "pill warn" }, icon(WARN), u.count + (u.count === 1 ? " update" : " updates") + (u.security ? ", " + u.security + " security" : "")),
      u.packages.length ? keep("pkgs-" + host.name, h("details", { class: "upd-pkgs" },
        h("summary", { text: "Show packages" }),
        h("p", { class: "mono", text: u.packages.join(", ") + (u.count > u.packages.length ? " and " + (u.count - u.packages.length) + " more" : "") }),
      )) : null,
      st8.asking ? null : h("button", {
        class: "btn small primary upd-btn",
        disabled: !u.canApply,
        "data-focus-key": "upd-" + host.name,
        title: u.canApply ? "Install them now" : "This login is not root and has no passwordless sudo, so JMCP cannot install updates here.",
        onclick: () => { hl.upd.set(host.name, { asking: true }); render(); focusLater("upd-cancel-" + host.name); },
      }, "Apply updates"),
    ),
    !u.canApply ? h("p", { class: "hint", text: "Can't apply from here: " + (host.user || "this user") + " is not root and has no passwordless sudo." }) : null,
    st8.asking ? h("div", { class: "warn-box upd-ask", role: "alertdialog", "aria-label": "Apply updates on " + host.name, onkeydown: (e) => { if (e.key === "Escape") { hl.upd.delete(host.name); render(); focusLater("upd-" + host.name); } } },
      h("p", { text: "Install " + u.count + (u.count === 1 ? " update" : " updates") + " on " + host.name + "? This runs " + tool + " as root. It keeps your config files, removes nothing and does not reboot. Services that get updated restart." }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn small primary", onclick: () => applyUpdates(host.name) }, "Install updates"),
        h("button", { class: "btn small", "data-focus-key": "upd-cancel-" + host.name, onclick: () => { hl.upd.delete(host.name); render(); focusLater("upd-" + host.name); } }, "Cancel"),
      ),
    ) : null,
  );
}

function hostCard(host, keys) {
  const r = hl.hosts.get(host.name);
  const checking = r && r.checking;
  const done = r && r.checkedAt !== undefined;
  const key = host.identityFiles.map((f) => keys.find((k) => k.path.toLowerCase() === f.toLowerCase())).filter(Boolean);
  const keyBad = key.some((k) => k.problems.some((p) => p.level === "problem"));
  const full = hl.full.get(host.name);
  const status = !done ? (checking ? ["", "Checking…"] : ["", "Not checked"]) : r.ok ? (r.problems.some((p) => p.level === "problem") ? ["bad", "Needs attention"] : r.problems.length ? ["warn", "Online, with warnings"] : ["ok", "Online"]) : ["bad", "Can't connect"];
  const worstDisk = done && r.ok && r.disks && r.disks.length ? r.disks.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null;
  return h("article", { class: "panel host" + (status[0] ? " " + status[0] : "") },
    h("div", { class: "host-head" },
      h("div", { class: "host-id" },
        h("h3", { class: "host-name mono", text: host.name }),
        h("span", { class: "host-addr mono", text: (host.user ? host.user + "@" : "") + (host.hostname || host.name) + (host.port && host.port !== "22" ? ":" + host.port : "") }),
      ),
      h("span", { class: "pill " + status[0] }, checking ? h("span", { class: "spinner small", "aria-hidden": "true" }) : status[0] ? icon(status[0] === "ok" ? CHECK : WARN) : null, done && checking ? "Checking…" : status[1]),
    ),
    host.note ? h("p", { class: "host-note", text: host.note }) : null,
    h("p", { class: "host-facts" },
      host.via ? h("span", {}, "Through ", h("code", { text: host.via })) : null,
      key.length ? h("span", { class: keyBad ? "bad-text" : "" }, "Key ", key.map((k) => h("code", { text: k.name }))) : host.identityFiles.length ? h("span", { class: "bad-text", text: "Key file missing" }) : h("span", { text: "Default keys" }),
      done && r.ok ? h("span", { text: r.os }) : null,
      done && r.ok && r.uptimeSec != null ? h("span", { text: "up " + uptime(r.uptimeSec) }) : null,
      done ? h("span", { text: (r.ok ? "answered in " + (r.ms / 1000).toFixed(1) + "s, " : "") + ago(r.checkedAt) }) : null,
    ),
    done && !r.ok ? h("p", { class: "host-error", text: r.error }) : null,
    done && r.ok ? h("div", { class: "gauges small" },
      gauge("CPU", r.cpuPct, r.cpus ? "load " + r.load[0] + " on " + r.cpus + " CPUs" : "", 70, 90),
      r.memory ? gauge("Memory", r.memory.usedPct, gb(Math.round((r.memory.totalMB * r.memory.usedPct) / 100)) + " of " + gb(r.memory.totalMB) + (r.swap && r.swap.usedPct ? ", swap " + r.swap.usedPct + "%" : "")) : null,
      worstDisk ? gauge("Disk " + worstDisk.mount, worstDisk.usedPct, worstDisk.freeGB + " GB free" + (r.disks.length > 1 ? " · fullest of " + r.disks.length : ""), 85, 95) : null,
    ) : null,
    done && r.ok ? issueList(r.problems) : null,
    done && r.ok && r.containers ? h("p", { class: "hint", text: r.containers.running + " containers running" + (r.containers.stopped ? ", " + r.containers.stopped + " stopped" : "") }) : null,
    done && r.ok ? updatesBlock(host, r) : hl.upd.get(host.name) && hl.upd.get(host.name).result ? updatesBlock(host, {}) : null,
    h("div", { class: "host-actions" },
      h("button", { class: "btn small", disabled: Boolean(checking), "aria-label": "Check " + host.name + " again", onclick: () => checkHost(host.name) }, checking ? "Checking…" : done ? "Check again" : "Check"),
      done && r.ok ? h("button", { class: "btn small quiet", disabled: Boolean(full && full.checking), title: "Journal, services, disks, memory and network. Read-only.", onclick: () => fullCheck(host.name) }, full && full.checking ? "Full check running…" : "Full check") : null,
    ),
    fullView(host.name),
  );
}

function keyRow(k) {
  const worst = k.problems.find((p) => p.level === "problem") || k.problems.find((p) => p.level === "warning");
  return h("tr", {},
    h("td", {}, h("span", { class: "mono key-name", text: k.name }), k.fingerprint ? h("span", { class: "key-fp mono", title: k.fingerprint, text: k.fingerprint }) : null),
    h("td", { text: k.exists ? (k.type || "Unknown") + (k.bits && k.type !== "Ed25519" ? " " + k.bits : "") : "Missing" }),
    h("td", {}, k.usedBy.length ? k.usedBy.map((n) => h("code", { text: n })) : h("span", { class: "faint", text: "Not in config" })),
    h("td", { text: k.passphrase === true ? "Yes" : k.passphrase === false ? "No" : "?" }),
    h("td", {}, worst ? h("span", { class: "pill " + (worst.level === "problem" ? "bad" : "warn"), title: k.problems.map((p) => p.text).join(" "), text: worst.level === "problem" ? "Problem" : "Warning" }) : h("span", { class: "pill ok" }, icon(CHECK), "OK"),
      k.problems.filter((p) => p.level !== "info").map((p) => h("span", { class: "key-why", text: p.text }))),
  );
}

function sshSection() {
  const inv = hl.ssh;
  const hosts = inv ? inv.hosts : [];
  const keys = inv ? inv.keys : [];
  const results = hosts.map((x) => hl.hosts.get(x.name)).filter((r) => r && r.checkedAt !== undefined);
  const down = results.filter((r) => !r.ok).length;
  const anyChecking = hosts.some((x) => (hl.hosts.get(x.name) || {}).checking);
  return h("section", { class: "hl-section", "aria-labelledby": "hl-ssh" },
    h("div", { class: "hl-section-head" },
      h("div", {},
        h("h2", { id: "hl-ssh" }, "SSH servers", hosts.length ? h("span", { class: "count-badge" + (down ? " bad" : ""), text: down ? down + " down" : String(hosts.length) }) : null),
        h("p", { class: "hint" }, "Hosts in ", h("code", { text: "~/.ssh/config" }), ". Each check logs in with your key only (no password prompts) and reads CPU, memory, disks, failed services and waiting updates. Checks change nothing; only Apply updates installs anything."),
      ),
      h("div", { class: "row-actions" },
        updatable().length && !hl.updAllAsk ? h("button", { class: "btn small primary", "data-focus-key": "upd-all", onclick: () => { hl.updAllAsk = true; render(); focusLater("upd-all-cancel"); } }, "Apply all updates (" + updatable().length + (updatable().length === 1 ? " server)" : " servers)")) : null,
        hosts.length ? h("button", { class: "btn small", disabled: anyChecking, onclick: () => { loadSsh(); checkAllHosts(); } }, anyChecking ? "Checking…" : "Check all") : null,
      ),
    ),
    hl.updAllAsk && updatable().length ? h("div", { class: "warn-box confirm-bar", role: "alertdialog", "aria-label": "Apply all updates", onkeydown: (e) => { if (e.key === "Escape") { hl.updAllAsk = false; render(); focusLater("upd-all"); } } },
      h("p", { text: "Install every waiting update on " + names(updatable().map((x) => x.name + " (" + hl.hosts.get(x.name).updates.count + ")")) + "? One server at a time, as root. Config files are kept, nothing is removed and nothing reboots." }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn primary", onclick: applyAll }, "Install all updates"),
        h("button", { class: "btn", "data-focus-key": "upd-all-cancel", onclick: () => { hl.updAllAsk = false; render(); focusLater("upd-all"); } }, "Cancel"),
      ),
    ) : null,
    hl.sshError ? h("div", { class: "error-box", role: "alert", text: "Could not read ~/.ssh: " + hl.sshError }) : null,
    !inv ? (hl.sshError ? null : h("div", { class: "panel empty", text: "Reading ~/.ssh/config…" })) :
    !hosts.length ? h("div", { class: "panel hl-empty" },
      h("p", { class: "hl-empty-title", text: "No SSH hosts yet" }),
      h("p", { class: "hint" }, "Add a ", h("code", { text: "Host" }), " block to ", h("code", { text: inv.configPath }), " and it shows up here."),
    ) :
    h("div", { class: "hosts" }, hosts.map((x) => hostCard(x, keys))),
    inv && keys.length ? h("div", { class: "panel keys" },
      h("div", { class: "keys-head" }, h("h3", { text: "SSH keys" }), h("span", { class: "hint", text: keys.length + " in ~/.ssh. Private keys never leave this computer; only their public part is read here." })),
      h("div", { class: "keys-scroll" },
        h("table", { class: "keys-table" },
          h("thead", {}, h("tr", {}, ["Key", "Type", "Used by", "Passphrase", "Status"].map((t) => h("th", { scope: "col", text: t })))),
          h("tbody", {}, keys.map(keyRow)),
        ),
      ),
    ) : null,
  );
}

function healthPage() {
  startHealth();
  return h("div", { class: "page hl-page" },
    head("Health", "Notes your agents left for you, this computer's performance, and your SSH servers and keys.",
      h("button", { class: "btn primary", onclick: checkEverything }, "Check everything")),
    serverStrip("health", "Agents use it to check computers and to leave you cards here."),
    notesSection(),
    localSection(),
    sshSection(),
  );
}
