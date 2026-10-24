"use strict";

// JMCP window. Pages: JMCP servers, Rules, Activity, and one page per agent.

window.__jmcpErrors = [];
window.addEventListener("error", (e) => window.__jmcpErrors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__jmcpErrors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

const api = window.jmcp;
const $main = document.getElementById("main");

let st = null; // {home, agents, catalog, node}
// --page agent-<id> in smoke runs (a colon in an argument reads as a URL to Electron).
let page = (new URLSearchParams(location.search).get("page") || "catalog").replace(/^agent-/, "agent:");
let busy = false;
let lastLog = null; // {server, results}
let picked = null; // Set of agent ids for the catalog install
const probes = new Map(); // "agent/name" -> {loading} | result
let act = null;
let openAct = "";

// ---- DOM helper ----
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const PAGES = [
  { id: "catalog", label: "JMCP servers", icon: "M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" },
  { id: "rules", label: "Rules", icon: "M4 3h12v14H4zM7 7h6M7 10h6M7 13h4" },
  { id: "instructions", label: "Instructions", icon: "M5 2h7l4 4v12H5zM12 2v4h4M8 10h5M8 13h5" },
  { id: "memory", label: "Memory", icon: "M5 3h10v14l-5-4-5 4z" },
  { id: "skills", label: "Skills", icon: "M11 2 4 11h5l-1 7 7-9h-5z" },
  { id: "health", label: "Health", icon: "M10 17s-7-4.3-7-9a3.8 3.8 0 0 1 7-2 3.8 3.8 0 0 1 7 2c0 4.7-7 9-7 9z" },
  { id: "activity", label: "Activity", icon: "M2 10h4l2-5 4 10 2-5h4" },
];

function icon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

function go(id) {
  page = id;
  render();
  $main.scrollTop = 0;
}

function renderSide() {
  const pages = document.getElementById("nav-pages");
  pages.replaceChildren(...PAGES.map((p) => h("button", { class: "nav-item" + (page === p.id ? " on" : ""), "aria-current": page === p.id ? "page" : null, "data-focus-key": "nav-" + p.id, onclick: () => go(p.id) }, icon(p.icon), h("span", { class: "grow", text: p.label }), p.id === "health" && typeof newNotes === "function" && newNotes() ? h("span", { class: "count new", title: newNotes() + " new from your agents", text: String(newNotes()) }) : null)));
  const list = document.getElementById("nav-agents");
  list.replaceChildren(
    ...st.agents.map((a) =>
      h("button", { class: "nav-item" + (page === "agent:" + a.id ? " on" : "") + (a.present ? "" : " absent"), "aria-current": page === "agent:" + a.id ? "page" : null, "data-focus-key": "nav-agent-" + a.id, onclick: () => go("agent:" + a.id), title: a.present ? a.name + ": " + a.servers.length + " MCP servers" : a.name + " was not found on this computer" },
        h("span", { class: "dot" + (a.present ? "" : " off") }),
        h("span", { class: "grow", text: a.name }),
        h("span", { class: "count", text: String(a.servers.length) }),
      ),
    ),
  );
  const found = st.agents.filter((a) => a.present).length;
  document.getElementById("side-foot").textContent = found + " of " + st.agents.length + " agents found";
}

function head(title, sub, actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), sub ? h("p", { text: sub }) : null), actions ? h("div", { class: "actions" }, actions) : null);
}

// Focus a control by its data-focus-key once the current render is in place.
function focusLater(key) {
  queueMicrotask(() => {
    const el = [...document.querySelectorAll("[data-focus-key]")].find((x) => x.dataset.focusKey === key);
    if (el) el.focus();
  });
}

function agentName(id) {
  const a = st.agents.find((x) => x.id === id);
  return a ? a.name : id;
}

// ---- JMCP servers ----

// Agents in the server grid, by short name so nine columns fit.
const SHORT = { "claude-code": "Claude", codex: "Codex", "factory-droid": "Droid", opencode: "OpenCode", devin: "Devin", cursor: "Cursor", gemini: "Gemini", qwen: "Qwen", grok: "Grok" };
const CHECK = "M5 10.5l3.2 3.2L15 7";
const PLUS = "M10 5v10M5 10h10";
const WARN = "M10 3l8 14H2zM10 8v4M10 14.5v.5";

function shortName(a) {
  return SHORT[a.id] || a.name.split(" ")[0];
}

function names(list) {
  return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0] || "";
}

let showAbsent = false;
let allLog = null; // {servers} | {error}

function coverage(found) {
  let have = 0;
  let full = 0;
  for (const c of st.catalog) {
    const n = found.filter((a) => c.installedIn.includes(a.id)).length;
    have += n;
    if (n === found.length) full++;
  }
  return { have, total: st.catalog.length * found.length, full };
}

async function runInstallAll() {
  if (busy) return;
  busy = true;
  allLog = null;
  lastLog = null;
  render();
  try {
    const r = await api.installAll();
    st = r.state;
    allLog = { servers: r.servers };
  } catch (e) {
    allLog = { error: e.message };
  }
  busy = false;
  render();
}

function allLogView() {
  if (!allLog) return null;
  if (allLog.error) return h("div", { class: "error-box", role: "alert", text: allLog.error });
  if (!allLog.servers.length) return h("div", { class: "ok-box", role: "status", text: "Everything was already installed." });
  const fails = [];
  const lines = [];
  for (const s of allLog.servers) {
    if (!s.ok) fails.push(s.server + ": " + s.error);
    const ok = (s.results || []).filter((x) => x.ok);
    for (const b of (s.results || []).filter((x) => !x.ok)) fails.push(s.server + " in " + agentName(b.agent) + ": " + b.error);
    if (ok.length) lines.push(s.server + " added to " + names(ok.map((x) => agentName(x.agent))));
  }
  const count = allLog.servers.reduce((n, s) => n + (s.results || []).filter((x) => x.ok).length, 0);
  return h("div", { class: fails.length ? "warn-box" : "ok-box", role: "status" },
    h("details", { class: "box-details", open: fails.length ? true : null },
      h("summary", { class: "box-title", text: (fails.length ? "Done, with " + fails.length + (fails.length === 1 ? " problem. " : " problems. ") : "") + count + (count === 1 ? " install" : " installs") + " done. Agents load new servers the next time they start." }),
      lines.length ? h("ul", { class: "box-list" }, lines.map((l) => h("li", { text: l }))) : null,
      fails.length ? h("ul", { class: "box-list bad" }, fails.map((l) => h("li", { text: l }))) : null,
    ),
    h("button", { class: "btn small quiet", "aria-label": "Dismiss", onclick: () => { allLog = null; render(); } }, "Dismiss"),
  );
}

function cell(c, a) {
  const on = c.installedIn.includes(a.id);
  return h("td", { class: "cell-td" + (a.present ? "" : " absent") },
    h("button", {
      class: "cell" + (on ? " on" : ""),
      disabled: busy,
      "aria-pressed": on ? "true" : "false",
      "aria-label": c.name + " in " + a.name,
      title: on ? c.name + " is in " + a.name + ". Click to remove it." : "Install " + c.name + " in " + a.name + (a.present ? "" : " (not found on this computer yet)"),
      "data-focus-key": "cell-" + c.id + "-" + a.id,
      onclick: () => (on ? askRemove(c, a) : runInstall(c.id, [a.id], false)),
    }, icon(on ? CHECK : PLUS)),
  );
}

let removing = null; // {c, a}

function askRemove(c, a) {
  removing = { c, a };
  render();
  focusLater("remove-cancel");
}

function removeView() {
  if (!removing) return null;
  const { c, a } = removing;
  const back = () => { removing = null; render(); focusLater("cell-" + c.id + "-" + a.id); };
  return h("div", { class: "warn-box confirm-bar", role: "alertdialog", "aria-label": "Remove server", onkeydown: (e) => { if (e.key === "Escape") back(); } },
    h("p", { text: "Remove " + c.name + " from " + a.name + "? Its entry in " + a.name + "'s config is deleted. You can install it again any time." }),
    h("div", { class: "row-actions" },
      h("button", { class: "btn danger", disabled: busy, onclick: () => { removing = null; runUninstall(c.id, [a.id]); } }, "Remove from " + a.name),
      h("button", { class: "btn", "data-focus-key": "remove-cancel", onclick: back }, "Cancel"),
    ),
  );
}

function serverRow(c, cols, found) {
  const missing = found.filter((a) => !c.installedIn.includes(a.id));
  return h("tr", {},
    h("td", { class: "srv" },
      h("div", { class: "srv-top" },
        h("span", { class: "srv-title", text: c.title }),
        h("code", { class: "srv-name", text: c.name }),
        c.updateAvailable ? h("span", { class: "pill warn", text: "Update " + c.installed + " → " + c.latest }) : h("span", { class: "srv-ver", text: "v" + (c.installed || c.latest) }),
      ),
      h("p", { class: "srv-desc", title: c.description, text: c.description }),
      h("p", { class: "srv-tools", title: c.tools.join(", "), text: c.tools.length + (c.tools.length === 1 ? " tool: " : " tools: ") + c.tools.join(", ") }),
      updateNote(c),
    ),
    cols.map((a) => cell(c, a)),
    h("td", { class: "srv-act" },
      c.updateAvailable ? h("button", { class: "btn small", disabled: busy, onclick: () => runUpdate(c.id) }, "Update") : null,
      missing.length
        ? h("button", { class: "btn small", disabled: busy, onclick: () => runInstall(c.id, missing.map((a) => a.id), false) }, "Add to " + missing.length + (missing.length === 1 ? " agent" : " agents"))
        : h("span", { class: "pill ok" }, icon(CHECK), "All"),
    ),
  );
}

function catalogPage() {
  const found = st.agents.filter((a) => a.present);
  const cols = showAbsent ? st.agents : found;
  const absent = st.agents.length - found.length;
  const cov = coverage(found);
  const done = cov.total > 0 && cov.have === cov.total;
  const fill = h("span", { class: "meter-fill" });
  fill.style.width = (cov.total ? Math.round((cov.have / cov.total) * 100) : 0) + "%";
  const hero = h("section", { class: "panel hero" + (done ? " done" : "") },
    h("div", { class: "hero-text" },
      h("h2", { text: done ? "Every JMCP server is in every agent" : "Install every JMCP server in every agent" }),
      h("p", { text: done
        ? "All " + st.catalog.length + " servers are in all " + found.length + " agents found on this computer."
        : "Install all adds each missing server to each agent found on this computer and leaves the rest as they are. Every config file is backed up before its first change." }),
      h("div", { class: "meter-row" },
        h("div", { class: "meter", role: "progressbar", "aria-label": "Servers installed", "aria-valuemin": "0", "aria-valuemax": String(cov.total), "aria-valuenow": String(cov.have) }, fill),
        h("span", { class: "meter-note", text: cov.have + " of " + cov.total + " installed" }),
      ),
    ),
    h("div", { class: "hero-action" },
      done
        ? h("span", { class: "pill ok big" }, icon(CHECK), "All installed")
        : h("button", { class: "btn primary big", disabled: busy || !found.length, onclick: runInstallAll }, busy ? "Installing…" : "Install all"),
    ),
  );
  const table = h("section", { class: "panel grid-panel" },
    h("div", { class: "grid-scroll" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {},
          h("th", { class: "srv", text: "Server" }),
          cols.map((a) => h("th", { class: "agent-col" + (a.present ? "" : " absent"), title: a.present ? a.name : a.name + " (not found)", text: shortName(a) })),
          h("th", { class: "srv-act" }),
        )),
        h("tbody", {}, st.catalog.map((c) => serverRow(c, cols, found))),
      ),
    ),
    h("div", { class: "grid-foot" },
      h("span", { class: "legend" }, h("span", { class: "cell on mini" }, icon(CHECK)), "Installed (click to remove)", h("span", { class: "cell mini" }, icon(PLUS)), "Click to install"),
      absent ? h("button", { class: "btn small quiet", onclick: () => { showAbsent = !showAbsent; render(); } }, showAbsent ? "Hide agents not found" : "Show " + absent + " agents not found") : null,
    ),
  );
  return h("div", { class: "page" },
    head("JMCP servers", "Shared MCP servers for all your coding agents. Install one and every agent you pick can use it."),
    hero,
    allLogView(),
    removeView(),
    table,
    lastLog ? h("div", { class: "panel log-panel" }, h("p", { class: "box-title", text: lastLog.server }), logView(lastLog)) : null,
  );
}

function logView(r) {
  return h(
    "ul",
    { class: "log" },
    r.results.map((x) =>
      h(
        "li",
        {},
        h("span", { class: "state " + (x.ok ? "ok" : "bad"), text: x.ok ? (x.removed === false ? "Not there" : r.kind === "install" ? "Installed" : "Removed") : "Failed" }),
        h("span", { text: agentName(x.agent) }),
        h("span", { class: "mono", text: x.ok ? x.file : x.error }),
      ),
    ),
  );
}

// Installing where it already is waits for the user to press Continue.
let pending = null; // {id, ids, already}

async function runInstall(id, ids, force) {
  busy = true;
  render();
  try {
    const r = await api.install(id, ids, force === true);
    st = r.state;
    lastLog = { server: r.server, kind: "install", results: r.results };
  } catch (e) {
    lastLog = { server: id, kind: "install", results: [{ ok: false, agent: "jmcp", error: e.message }] };
  }
  busy = false;
  render();
}

// Updates the app made when it started, and any made from the Update button.
let updates = [];

function updateNote(c) {
  const u = updates.find((x) => x.server === c.name);
  if (!u) return null;
  if (!u.ok) return h("div", { class: "error-box", text: "Update failed: " + u.error });
  return h("p", { class: "server-desc", text: "Updated from " + u.from + " to " + u.to + (u.atStart ? " when JMCP started" : "") + ". Agents load the new version the next time they start it." });
}

async function runUpdate(id) {
  busy = true;
  render();
  try {
    const r = await api.update(id);
    st = r.state;
    updates = updates.filter((x) => x.server !== r.server).concat([Object.assign({ ok: true }, r)]);
  } catch (e) {
    const c = st.catalog.find((x) => x.id === id);
    updates = updates.filter((x) => x.server !== c.name).concat([{ ok: false, server: c.name, error: e.message }]);
  }
  busy = false;
  render();
}

async function runUninstall(id, ids) {
  busy = true;
  render();
  try {
    const r = await api.uninstall(id, ids);
    st = r.state;
    lastLog = { server: r.server, kind: "uninstall", results: r.results };
  } catch (e) {
    lastLog = { server: id, kind: "uninstall", results: [{ ok: false, agent: "jmcp", error: e.message }] };
  }
  busy = false;
  render();
}

// ---- Rules ----

let rules = null;
let rulesLoading = null;
let rulesError = "";
let rulesInstallLog = null;
let addDraft = { kind: "do", text: "" };
let editId = "";
let editDraft = null;
let deleteId = "";
let ruleFilter = "all"; // all | do | dont
let preview = null; // {text} | {error}

const KINDS = [["do", "Do"], ["dont", "Don't"]];

function seg(label, options, value, key, pick) {
  const ids = options.map((o) => o[0]);
  const move = (e) => {
    const i = ids.indexOf(value);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? ids[(i + 1) % ids.length]
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? ids[(i - 1 + ids.length) % ids.length]
      : e.key === "Home" ? ids[0] : e.key === "End" ? ids[ids.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    pick(next);
    focusLater(key + "-" + next);
  };
  return h("div", { class: "seg", role: "radiogroup", "aria-label": label, onkeydown: move },
    options.map(([id, text, count]) => h("button", {
      type: "button",
      class: "seg-btn" + (value === id ? " on" : ""),
      role: "radio",
      tabindex: value === id ? "0" : "-1",
      "aria-checked": String(value === id),
      "data-focus-key": key + "-" + id,
      onclick: () => pick(id),
    }, text, count === undefined ? null : h("span", { class: "n", text: String(count) }))),
  );
}

function ruleFields(draft, key, submit, label) {
  const isNew = key === "new";
  return h(
    "form",
    { class: "rule-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
    h("div", { class: "rule-form-top" },
      isNew ? h("h2", { text: "Add a rule" }) : h("span", { class: "field-label", text: "Edit rule" }),
      seg(isNew ? "New rule type" : "Edit rule type", KINDS, draft.kind, key + "-kind", (kind) => { draft.kind = kind; render(); }),
    ),
    h("textarea", {
      rows: "2",
      required: true,
      placeholder: draft.kind === "do" ? "Something agents should always do. Example: Run the tests before saying a change is done." : "Something agents must not do. Example: Push to main without asking first.",
      "aria-label": isNew ? "New rule text" : "Edit rule text",
      "data-focus-key": key + "-text",
      oninput: (e) => { draft.text = e.target.value; },
      onkeydown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } },
    }, draft.text),
    h("div", { class: "rule-form-foot" },
      h("span", { class: "hint", text: isNew ? "Applies to every agent. Ctrl+Enter adds it." : "Applies to every agent." }),
      h("div", { class: "row-actions" },
        isNew ? null : h("button", { class: "btn", type: "button", disabled: busy, onclick: () => { editId = ""; editDraft = null; render(); } }, "Cancel"),
        h("button", { class: "btn primary", type: "submit", disabled: busy }, busy ? "Working…" : label),
      ),
    ),
  );
}

// The list and the exact text agents get, fetched together after every change.
async function fetchRules() {
  const [list, text] = await Promise.allSettled([api.rules.list(), api.rules.preview()]);
  if (list.status === "fulfilled") {
    rules = list.value;
    rulesError = "";
  } else {
    rules = rules || [];
    rulesError = list.reason.message;
  }
  preview = text.status === "fulfilled" ? { text: text.value } : { error: text.reason.message };
}

async function changeRule(work, done) {
  busy = true;
  rulesError = "";
  render();
  try {
    await work();
    if (done) done();
    await fetchRules();
  } catch (e) {
    rulesError = e.message;
  }
  busy = false;
  render();
}

function validDraft(draft) {
  if (!draft.text.trim()) { rulesError = "Enter a rule."; render(); return false; }
  return true;
}

function addRule() {
  if (!validDraft(addDraft)) return;
  const input = { kind: addDraft.kind, text: addDraft.text.trim() };
  changeRule(() => api.rules.add(input), () => { addDraft = { kind: addDraft.kind, text: "" }; });
}

function saveRule(id) {
  if (!validDraft(editDraft)) return;
  const patch = { kind: editDraft.kind, text: editDraft.text.trim() };
  changeRule(() => api.rules.update(id, patch), () => { editId = ""; editDraft = null; });
}

function ruleRow(rule) {
  if (editId === rule.id) {
    return h("div", { class: "rule-row editing" }, ruleFields(editDraft, "edit-" + rule.id, () => saveRule(rule.id), "Save rule"));
  }
  const deleting = deleteId === rule.id;
  return h(
    "div",
    { class: "rule-row" + (rule.enabled ? "" : " rule-off") },
    h("label", { class: "switch", title: rule.enabled ? "On: agents read this rule" : "Off: agents skip this rule" },
      h("input", { type: "checkbox", role: "switch", checked: rule.enabled, disabled: busy, "aria-label": (rule.enabled ? "Disable" : "Enable") + " rule: " + rule.text, "data-focus-key": "toggle-" + rule.id, onchange: (e) => changeRule(() => api.rules.update(rule.id, { enabled: e.target.checked })) }),
      h("span", { class: "switch-track", "aria-hidden": "true" }),
    ),
    h("span", { class: "kind kind-" + rule.kind, text: rule.kind === "do" ? "Do" : "Don't" }),
    h("div", { class: "rule-content" },
      h("div", { class: "rule-text", text: rule.text }),
      rule.enabled ? null : h("div", { class: "rule-meta", text: "Off. Agents skip this rule." }),
    ),
    deleting
      ? h("div", { class: "rule-actions confirm", role: "alertdialog", "aria-label": "Delete rule", onkeydown: (e) => { if (e.key === "Escape") { deleteId = ""; render(); focusLater("del-" + rule.id); } } },
        h("span", { text: "Delete?" }),
        h("button", { class: "btn small danger", disabled: busy, onclick: () => changeRule(() => api.rules.remove(rule.id), () => { deleteId = ""; }) }, "Delete rule"),
        h("button", { class: "btn small", disabled: busy, "data-focus-key": "del-cancel-" + rule.id, onclick: () => { deleteId = ""; render(); focusLater("del-" + rule.id); } }, "Cancel"),
      )
      : h("div", { class: "rule-actions" },
        h("button", { class: "btn small quiet", disabled: busy, onclick: () => {
          editId = rule.id;
          editDraft = { kind: rule.kind, text: rule.text };
          deleteId = "";
          render();
        } }, "Edit"),
        h("button", { class: "btn small quiet danger", disabled: busy, "data-focus-key": "del-" + rule.id, onclick: () => { deleteId = rule.id; render(); focusLater("del-cancel-" + rule.id); } }, "Delete"),
      ),
  );
}

// One line on the Rules, Instructions, Memory and Skills pages: which found
// agents have that page's server, and a button for the rest.
const stripLogs = new Map();

function serverStrip(serverId, note) {
  const c = st.catalog.find((x) => x.id === serverId);
  if (!c) return h("div", { class: "error-box", role: "alert", text: "This JMCP build has no " + serverId + " server." });
  const found = st.agents.filter((a) => a.present);
  const missing = found.filter((a) => !c.installedIn.includes(a.id));
  const off = found.filter((a) => a.servers.some((s) => s.name === c.name && !s.enabled));
  const log = stripLogs.get(serverId);
  const all = found.length && !missing.length && !off.length;
  return h("section", { class: "strip" + (all ? "" : " warn") },
    h("span", { class: "strip-icon" }, icon(all ? CHECK : WARN)),
    h("div", { class: "strip-text" },
      h("span", { class: "strip-title" }, h("code", { text: c.name }), !found.length ? " needs an agent. None were found." : all ? " is in all " + found.length + " agents" : " is in " + (found.length - missing.length) + " of " + found.length + " agents"),
      h("span", { class: "strip-sub", text: (missing.length && missing.length <= 4 ? "Missing in " + names(missing.map((a) => a.name)) + ". " : "") + (off.length ? "Turned off in " + names(off.map((a) => a.name)) + "'s config. " : "") + note }),
    ),
    missing.length ? h("button", { class: "btn", disabled: busy, onclick: () => stripInstall(serverId, missing.map((a) => a.id)) }, busy ? "Working…" : "Install in " + missing.length + " more") : null,
    log ? h("div", { class: "strip-log" }, logView(log)) : null,
  );
}

async function stripInstall(serverId, ids) {
  if (busy) return;
  busy = true;
  stripLogs.delete(serverId);
  render();
  try {
    const r = await api.install(serverId, ids);
    st = r.state;
    if (r.results.some((x) => !x.ok)) stripLogs.set(serverId, { server: r.server, kind: "install", results: r.results });
  } catch (e) {
    stripLogs.set(serverId, { server: serverId, kind: "install", results: [{ ok: false, agent: "jmcp", error: e.message }] });
  }
  busy = false;
  render();
}

function listPanel() {
  const count = (kind) => rules.filter((r) => r.kind === kind).length;
  const ordered = KINDS.flatMap(([kind]) => rules.filter((r) => r.kind === kind));
  const shown = ruleFilter === "all" ? ordered : ordered.filter((r) => r.kind === ruleFilter);
  return h("section", { class: "panel rule-list-panel" },
    h("div", { class: "rule-list-head" },
      h("h2", { text: "Your rules" }),
      rules.length ? seg("Show rules", [["all", "All", rules.length], ["do", "Do", count("do")], ["dont", "Don't", count("dont")]], ruleFilter, "filter", (f) => { ruleFilter = f; render(); }) : null,
    ),
    !rules.length ? h("div", { class: "rule-empty" },
      h("p", { class: "rule-empty-title", text: "No rules yet" }),
      h("p", { text: "Add one above. Every agent with jmcp-rules reads it, so you only write it once." }),
    )
      : shown.length ? h("div", { class: "rule-list" }, shown.map(ruleRow))
      : h("div", { class: "rule-empty" }, h("p", { text: "No " + (ruleFilter === "do" ? "Do" : "Don't") + " rules yet." })),
  );
}

function previewPanel() {
  const n = rules ? rules.filter((r) => r.enabled).length : 0;
  return h("aside", { class: "panel rule-preview-panel" },
    h("h2", { text: "What every agent reads" }),
    h("p", { class: "note", text: rules ? n + (n === 1 ? " rule is on." : " rules are on.") + " Each agent gets this same text." : "Each agent gets this same text." }),
    !preview ? h("pre", { class: "rule-preview", text: "Loading preview…" })
      : preview.error ? h("div", { class: "error-box", text: preview.error })
      : preview.text ? h("pre", { class: "rule-preview", text: preview.text })
      : h("div", { class: "rule-preview empty-preview", text: "No rules are on yet." }),
  );
}

let rulesStale = false;
let insStale = false;

function rulesPage() {
  if ((!rules || rulesStale) && !rulesLoading && !busy) {
    rulesStale = false;
    rulesLoading = fetchRules().finally(() => { rulesLoading = null; render(); });
  }
  return h(
    "div",
    { class: "page" },
    head("Rules", "Write a rule once. Every agent with jmcp-rules follows it."),
    serverStrip("rules", "Running agents get changes the next time they call the rules tool."),
    rulesError ? h("div", { class: "error-box", role: "alert", text: rulesError }) : null,
    h("div", { class: "rules-grid" },
      h("div", { class: "rules-main" },
        h("section", { class: "panel composer" }, ruleFields(addDraft, "new", addRule, "Add rule")),
        !rules ? h("div", { class: "panel empty", text: "Loading rules…" }) : listPanel(),
      ),
      previewPanel(),
    ),
  );
}

// ---- Instructions ----

let ins = null; // {agents, folders}
let insLoading = null;
let insError = "";
let insTrash = [];
let insLog = null; // {ok, text}
let sel = null; // {path, label, exists, text, hash, draft, loading, error}
let insAsk = null; // {kind: "delete"} | {kind: "open", file} | {kind: "folder", path} | {kind: "forget", id}
let folderDraft = "";
let newIn = ""; // folder whose New file picker is open
const trashView = new Map(); // id -> text | {error}

const INS_NAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md"];

function kb(n) {
  return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
}

function dirty() {
  return Boolean(sel && !sel.loading && !sel.error && sel.draft !== sel.text);
}

function sep(p) {
  return p.includes("\\") ? "\\" : "/";
}

async function fetchIns() {
  const [list, trash] = await Promise.allSettled([api.instructions.list(), api.instructions.trash()]);
  if (list.status === "fulfilled") {
    ins = list.value;
    insError = "";
  } else {
    ins = ins || { agents: [], folders: [] };
    insError = list.reason.message;
  }
  if (trash.status === "fulfilled") insTrash = trash.value;
}

async function insWork(work, done) {
  busy = true;
  insError = "";
  render();
  try {
    const r = await work();
    if (done) await done(r);
    await fetchIns();
  } catch (e) {
    insError = e.message;
  }
  busy = false;
  render();
}

// Opening another file with unsaved changes asks first.
function askOpen(file) {
  if (sel && sel.path === file.path) return;
  if (dirty()) {
    insAsk = { kind: "open", file };
    render();
    return focusLater("ins-keep");
  }
  openFile(file);
}

async function openFile(file) {
  insAsk = null;
  newIn = "";
  sel = { path: file.path, label: file.label, exists: file.exists, text: "", hash: "", draft: "", loading: file.exists, error: "" };
  render();
  if (!file.exists) return;
  try {
    const r = await api.instructions.read(file.path);
    if (sel && sel.path === file.path) Object.assign(sel, { text: r.text, draft: r.text, hash: r.hash, loading: false });
  } catch (e) {
    if (sel && sel.path === file.path) Object.assign(sel, { loading: false, error: e.message });
  }
  render();
}

function saveFile() {
  if (!sel || busy || sel.loading || sel.error) return;
  const file = sel.path;
  const draft = sel.draft;
  insWork(() => api.instructions.write(file, draft, sel.exists ? sel.hash : ""), (r) => {
    if (sel && sel.path === file) Object.assign(sel, { exists: true, text: draft, hash: r.hash });
    insLog = { ok: true, text: (r.created ? "Created " : r.changed ? "Saved " : "No changes in ") + file };
  });
}

function deleteFile() {
  const file = sel.path;
  insWork(() => api.instructions.remove(file), () => {
    insAsk = null;
    sel = null;
    insLog = { ok: true, text: "Deleted " + file + ". You can restore it from Deleted and replaced." };
  });
}

function addFolder(folder) {
  if (!folder.trim()) {
    insError = "Enter a folder path.";
    return render();
  }
  insWork(() => api.instructions.addFolder(folder.trim()), () => { folderDraft = ""; });
}

async function browseFolder() {
  try {
    const f = await api.pickFolder();
    if (f) addFolder(f);
  } catch (e) {
    insError = e.message;
    render();
  }
}

function fileRow(file, label, sub) {
  const on = Boolean(sel && sel.path === file.path);
  return h("button", { class: "ins-file" + (on ? " on" : "") + (file.exists ? "" : " missing"), "aria-current": on ? "true" : null, title: file.path, onclick: () => askOpen({ path: file.path, label, exists: file.exists }) },
    h("span", { class: "file-icon" + (file.exists ? "" : " off") }, icon("M5 2h7l4 4v12H5zM12 2v4h4")),
    h("span", { class: "grow" }, h("span", { class: "ins-name", text: label }), sub ? h("span", { class: "ins-sub", text: sub }) : null),
    h("span", { class: "ins-size", text: file.exists ? kb(file.size) : "Not made" }),
  );
}

function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function folderGroup(d) {
  const missing = INS_NAMES.filter((n) => !d.files.some((f) => f.name === n));
  const asking = insAsk && insAsk.kind === "folder" && insAsk.path === d.path;
  const openHere = Boolean(sel && sel.path.startsWith(d.path + sep(d.path)));
  return h("div", { class: "ins-group" + (d.detected ? " detected" : "") },
    h("div", { class: "ins-folder" },
      h("span", { class: "grow ins-folder-name", title: d.path }, h("span", { class: "ins-name", text: baseName(d.path) }), h("span", { class: "ins-sub mono", text: d.path })),
      d.detected
        ? h("button", { class: "btn small", disabled: busy, title: "Keep this folder in the list, and let agents list it through jmcp-instructions.", onclick: () => addFolder(d.path) }, "Save")
        : d.exists && missing.length ? h("button", { class: "btn small quiet", disabled: busy, "aria-expanded": newIn === d.path ? "true" : "false", onclick: () => { newIn = newIn === d.path ? "" : d.path; render(); } }, "New file") : null,
      h("button", { class: "btn small quiet", disabled: busy, title: "Stop showing this folder. Its files stay.", "aria-label": "Hide " + d.path, "data-focus-key": "hide-" + d.path, onclick: () => { insAsk = { kind: "folder", path: d.path }; render(); focusLater("hide-cancel-" + d.path); } }, "Hide"),
    ),
    asking ? h("div", { class: "ins-confirm", role: "alertdialog", "aria-label": "Hide folder", onkeydown: (e) => { if (e.key === "Escape") { insAsk = null; render(); focusLater("hide-" + d.path); } } },
      h("span", { text: openHere && dirty() ? "Stop showing this folder? Your unsaved changes to " + sel.label + " will be lost. Its files are not deleted." : "Stop showing this folder? Its files are not deleted." }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn small danger", disabled: busy, onclick: () => insWork(() => api.instructions.removeFolder(d.path), () => { insAsk = null; detected = detected && detected.filter((x) => x.path !== d.path); if (openHere) sel = null; }) }, openHere && dirty() ? "Discard and hide" : "Hide folder"),
        h("button", { class: "btn small", disabled: busy, "data-focus-key": "hide-cancel-" + d.path, onclick: () => { insAsk = null; render(); focusLater("hide-" + d.path); } }, "Cancel"),
      ),
    ) : null,
    newIn === d.path ? h("div", { class: "ins-new" }, h("span", { class: "hint", text: "Make" }), missing.map((n) =>
      h("button", { class: "btn small", onclick: () => askOpen({ path: d.path + sep(d.path) + n, label: n, exists: false }) }, n))) : null,
    !d.exists ? h("div", { class: "ins-empty", text: "This folder is missing." })
      : d.files.length ? d.files.map((f) => fileRow(f, f.name, ""))
      : h("div", { class: "ins-empty", text: "No instruction files here yet." }),
  );
}

let detected = null; // folders found on this computer, newest edits first
let detectLoading = null;
let projQ = "";
let showAllFound = false;
let addingFolder = false;
let insTab = "agents"; // agents | projects

function loadDetected() {
  if (detected || detectLoading) return;
  detectLoading = api.instructions.detect()
    .then((d) => { detected = d; })
    .catch((e) => { detected = []; insError = "Could not look for project folders: " + e.message; })
    .finally(() => { detectLoading = null; render(); });
}

const MASTER = "Master instructions";

// The one file every agent gets as instructions it must follow.
function masterRow() {
  if (!ins.master) return null;
  return h("div", { class: "ins-master" }, fileRow(ins.master, MASTER, "Every agent must follow these"));
}

function isMasterSel() {
  return Boolean(sel && ins && ins.master && sel.path === ins.master.path);
}

function filesPanel() {
  loadDetected();
  const q = projQ.trim().toLowerCase();
  const hit = (d) => !q || d.path.toLowerCase().includes(q);
  const saved = ins.folders.filter(hit);
  const foundAll = (detected || []).filter((d) => hit(d) && !ins.folders.some((f) => f.path.toLowerCase() === d.path.toLowerCase()));
  const found = showAllFound || q ? foundAll : foundAll.slice(0, 8);
  const made = ins.agents.filter((f) => f.exists).length;
  const tabs = h("div", { class: "ins-tabs" }, seg("Show", [["agents", "Agent files", made + "/" + ins.agents.length], ["projects", "Projects", ins.folders.length + (detected ? foundAll.length : 0)]], insTab, "ins-tab", (t) => { insTab = t; render(); }));
  if (insTab === "agents") {
    return h("section", { class: "panel ins-files" },
      masterRow(),
      tabs,
      h("div", { class: "ins-scroll" },
        h("p", { class: "hint ins-lead", text: "Each agent reads its own file in every session. Pick one to read or edit it." }),
        ins.agents.map((f) => fileRow(f, f.agent, f.name)),
      ),
    );
  }
  return h("section", { class: "panel ins-files" },
    masterRow(),
    tabs,
    h("div", { class: "ins-scroll" },
    h("div", { class: "ins-head ins-head-split" },
      h("div", {}, h("h2", { text: "Saved folders" }), h("span", { class: "hint", text: "Agents read a folder's files when they work in it." })),
      h("button", { class: "btn small", disabled: busy, "aria-expanded": addingFolder ? "true" : "false", onclick: () => { addingFolder = !addingFolder; render(); if (addingFolder) focusLater("ins-folder"); } }, "Add"),
    ),
    addingFolder ? h("form", { class: "ins-add", onsubmit: (e) => { e.preventDefault(); addFolder(folderDraft); } },
      h("input", { type: "text", placeholder: "C:\\path\\to\\project", "aria-label": "Folder path", "data-focus-key": "ins-folder", value: folderDraft, oninput: (e) => { folderDraft = e.target.value; } }),
      h("button", { class: "btn small primary", type: "submit", disabled: busy }, "Add"),
      h("button", { class: "btn small", type: "button", disabled: busy, onclick: browseFolder }, "Browse…"),
    ) : null,
    h("div", { class: "ins-filter" }, h("input", { type: "search", class: "lib-search", placeholder: "Filter folders", "aria-label": "Filter folders", "data-focus-key": "ins-q", value: projQ, oninput: (e) => { projQ = e.target.value; render(); } })),
    saved.map(folderGroup),
    h("div", { class: "ins-sub-head" },
      h("span", { text: "Found on this computer" }),
      h("span", { class: "hint", text: detected ? String(foundAll.length) : "" }),
    ),
    !detected ? h("div", { class: "ins-empty", text: "Looking for project folders…" })
      : !foundAll.length ? h("div", { class: "ins-empty", text: q ? "No found folders match." : "No other folders with instruction files were found." })
      : found.map(folderGroup),
    detected && foundAll.length > found.length ? h("button", { class: "btn small quiet ins-more", onclick: () => { showAllFound = true; render(); } }, "Show all " + foundAll.length) : null,
    ),
  );
}

function editorPanel() {
  if (!sel) {
    return h("section", { class: "panel ins-editor ins-blank" },
      h("p", { class: "rule-empty-title", text: "Pick a file" }),
      h("p", { class: "note", text: "Choose an agent file or a project file to read or edit it. Files that are not made yet can be created." }),
    );
  }
  // Typing updates only this label, not the whole page.
  const status = h("span", { class: "hint ins-status" });
  const setStatus = () => {
    const d = dirty();
    const text = !sel.exists ? "New file. Save to create it." : d ? "Unsaved changes" : "Saved";
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle("warn", d);
  };
  setStatus();
  const deleting = insAsk && insAsk.kind === "delete";
  const opening = insAsk && insAsk.kind === "open";
  const masterOpen = isMasterSel();
  return h("section", { class: "panel ins-editor" },
    h("div", { class: "ins-editor-head" },
      h("div", { class: "grow ins-title" }, h("h2", { text: sel.label }), h("span", { class: "mono note", title: sel.path, text: sel.path })),
      h("div", { class: "row-actions" },
        sel.exists ? h("button", { class: "btn small quiet", onclick: () => api.reveal(sel.path) }, "Show in folder") : null,
        sel.exists && !deleting ? h("button", { class: "btn small quiet danger", disabled: busy || sel.loading, onclick: () => { insAsk = { kind: "delete" }; render(); } }, "Delete file") : null,
      ),
    ),
    deleting ? h("div", { class: "warn-box", role: "alertdialog", "aria-label": "Delete file" },
      h("p", { text: (masterOpen ? "Delete the master instructions? Agents stop getting them." : "Delete " + sel.path + "? Agents stop reading it.") + " You can restore it from Deleted and replaced." }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn danger", disabled: busy, onclick: deleteFile }, "Delete file"),
        h("button", { class: "btn", disabled: busy, onclick: () => { insAsk = null; render(); } }, "Cancel"),
      ),
    ) : null,
    opening ? h("div", { class: "warn-box", role: "alertdialog", "aria-label": "Unsaved changes", onkeydown: (e) => { if (e.key === "Escape") { insAsk = null; render(); focusLater("ins-text"); } } },
      h("p", { text: insAsk.reload ? sel.label + " has unsaved changes. Reload it from disk and lose them?" : sel.label + " has unsaved changes. Open " + insAsk.file.label + " and lose them?" }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn danger", onclick: () => openFile(insAsk.file) }, insAsk.reload ? "Discard and reload" : "Discard and open"),
        h("button", { class: "btn", "data-focus-key": "ins-keep", onclick: () => { insAsk = null; render(); focusLater("ins-text"); } }, "Keep editing"),
      ),
    ) : null,
    masterOpen ? h("p", { class: "note", text: "Every agent with jmcp-instructions gets this text as master instructions it must follow. Agents can read it but not change it. Running agents see changes when they call master_instructions or start a new session." }) : null,
    sel.loading ? h("div", { class: "empty", text: "Loading files…" })
      : sel.error ? h("div", { class: "error-box", role: "alert", text: sel.error })
      : h("textarea", {
          class: "ins-text",
          spellcheck: "false",
          "aria-label": "File text",
          "data-focus-key": "ins-text",
          placeholder: masterOpen ? "What every agent must always do or never do." : "# Agent instructions\n\nWhat agents should know and do.",
          oninput: (e) => { sel.draft = e.target.value; setStatus(); },
          onkeydown: (e) => { if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveFile(); } },
        }, sel.draft),
    h("div", { class: "rule-form-foot" },
      status,
      h("div", { class: "row-actions" },
        sel.exists ? h("button", { class: "btn", disabled: busy || sel.loading, onclick: () => { const file = { path: sel.path, label: sel.label, exists: true }; if (dirty()) { insAsk = { kind: "open", file, reload: true }; render(); focusLater("ins-keep"); } else openFile(file); } }, "Reload") : null,
        h("button", { class: "btn primary", disabled: busy || sel.loading || Boolean(sel.error), onclick: saveFile }, busy ? "Working…" : sel.exists ? "Save" : "Create file"),
      ),
    ),
    h("span", { class: "hint", text: "Ctrl+S saves. The old version is kept in Deleted and replaced." }),
  );
}

function trashRow(t) {
  const open = trashView.has(t.id);
  const view = trashView.get(t.id);
  const forgetting = insAsk && insAsk.kind === "forget" && insAsk.id === t.id;
  const who = t.by === "agent" ? "an agent" : t.by === "restore" ? "a restore" : "you";
  return h("div", { class: "ins-trash-row" },
    h("div", { class: "ins-trash-top" },
      h("span", { class: "state " + (t.reason === "deleted" ? "bad" : "warn"), text: t.reason === "deleted" ? "Deleted" : "Replaced" }),
      h("span", { class: "grow ins-trash-path" }, h("span", { class: "mono", title: t.path, text: t.path }), h("span", { class: "hint", text: "By " + who + ", " + ago(t.at) + ", " + kb(t.size) })),
      forgetting
        ? h("div", { class: "row-actions", role: "alertdialog", "aria-label": "Delete copy", onkeydown: (e) => { if (e.key === "Escape") { insAsk = null; render(); } } },
            h("span", { class: "hint", text: "Delete this copy for good?" }),
            h("button", { class: "btn small danger", disabled: busy, onclick: () => insWork(() => api.instructions.forget(t.id), () => { insAsk = null; trashView.delete(t.id); }) }, "Delete copy"),
            h("button", { class: "btn small", disabled: busy, "data-focus-key": "forget-cancel-" + t.id, onclick: () => { insAsk = null; render(); } }, "Cancel"),
          )
        : h("div", { class: "row-actions" },
            h("button", { class: "btn small quiet", "aria-expanded": open ? "true" : "false", onclick: async () => {
              if (open) {
                trashView.delete(t.id);
                return render();
              }
              try {
                trashView.set(t.id, await api.instructions.trashText(t.id));
              } catch (e) {
                trashView.set(t.id, { error: e.message });
              }
              render();
            } }, open ? "Hide" : "View"),
            h("button", { class: "btn small", disabled: busy, title: "Put this copy back. The current file, if any, is kept here first.", onclick: () => insWork(() => api.instructions.restore(t.id), () => {
              trashView.delete(t.id);
              insLog = { ok: true, text: "Restored " + t.path };
              if (sel && sel.path === t.path && !dirty()) openFile({ path: sel.path, label: sel.label, exists: true });
            }) }, "Restore"),
            h("button", { class: "btn small quiet danger", disabled: busy, onclick: () => { insAsk = { kind: "forget", id: t.id }; render(); focusLater("forget-cancel-" + t.id); } }, "Delete"),
          ),
    ),
    open ? (view && view.error ? h("div", { class: "error-box", text: view.error }) : h("pre", { class: "rule-preview ins-trash-text", text: view || "(empty file)" })) : null,
  );
}

let showTrash = false;

function trashPanel() {
  return h("section", { class: "section" },
    h("button", { class: "disclose", "aria-expanded": showTrash ? "true" : "false", onclick: () => { showTrash = !showTrash; render(); } },
      icon(showTrash ? "M5 8l5 5 5-5" : "M8 5l5 5-5 5"),
      h("h2", { text: "Deleted and replaced" }),
      h("span", { class: "count-pill", text: String(insTrash.length) }),
      h("span", { class: "note", text: "Copies kept before a file was deleted or overwritten. The newest 300 are kept." }),
    ),
    showTrash ? (insTrash.length ? h("div", { class: "panel" }, insTrash.map(trashRow)) : h("div", { class: "panel empty", text: "Nothing here yet." })) : null,
  );
}

function instructionsPage() {
  if ((!ins || insStale) && !insLoading && !busy) {
    insStale = false;
    insLoading = fetchIns().finally(() => { insLoading = null; render(); });
  }
  return h("div", { class: "page" },
    head("Instructions", "Master instructions for every agent, plus AGENTS.md, CLAUDE.md and the other files your agents read.", [
      h("button", { class: "btn", disabled: busy, onclick: () => { detected = null; insWork(async () => {}); } }, "Refresh"),
    ]),
    serverStrip("instructions", "With it, every agent gets your master instructions, and you can ask any agent to read, edit, create or delete these files."),
    insError ? h("div", { class: "error-box", role: "alert", text: insError }) : null,
    insLog ? h("div", { class: insLog.ok ? "ok-box" : "error-box", role: "status" }, h("span", { text: insLog.text }), h("button", { class: "btn small quiet", "aria-label": "Dismiss", onclick: () => { insLog = null; render(); } }, "Dismiss")) : null,
    !ins ? h("div", { class: "panel empty", text: "Loading files…" }) : h("div", { class: "ins-grid" }, filesPanel(), editorPanel()),
    ins ? trashPanel() : null,
  );
}

// ---- One agent ----

function agentPage(id) {
  const a = st.agents.find((x) => x.id === id);
  if (!a) return h("div", { class: "page" }, head("Not found", ""));
  const rows = a.servers.map((s) => {
    const key = a.id + "/" + s.name;
    const pr = probes.get(key);
    const where = s.url || [s.command].concat(s.args).join(" ");
    const envKeys = Object.keys(s.env || {});
    return h("tr", {},
      h("td", { class: "name" }, h("span", { text: s.name }), s.name.startsWith("jmcp-") ? h("span", { class: "tag", text: "JMCP" }) : null),
      h("td", { class: "cmd" },
        h("span", { class: "mono", title: where, text: where }),
        envKeys.length ? h("span", { class: "mono", title: envKeys.join(", "), text: "env: " + envKeys.join(", ") }) : null,
        pr && pr.result ? probeView(pr.result) : null,
      ),
      h("td", { class: "fit" }, h("span", { class: "tag", text: s.transport })),
      h("td", { class: "fit" }, h("span", { class: "pill" + (s.enabled ? " ok" : ""), text: s.enabled ? "On" : "Off" })),
      h("td", { class: "fit" }, s.transport === "stdio" ? h("button", { class: "btn small", disabled: pr && pr.loading, onclick: () => runProbe(a.id, s.name) }, pr && pr.loading ? "Checking…" : "Check tools") : null),
    );
  });
  const jmcpRows = st.catalog.map((c) => {
    const inIt = c.installedIn.includes(a.id);
    return h("div", { class: "jrow" },
      h("button", { class: "cell" + (inIt ? " on" : ""), disabled: busy, "aria-pressed": inIt ? "true" : "false", "aria-label": c.name + " in " + a.name, "data-focus-key": "cell-" + c.id + "-" + a.id, title: inIt ? "Installed. Click to remove." : "Click to install", onclick: () => (inIt ? askRemove(c, a) : runInstall(c.id, [a.id], false)) }, icon(inIt ? CHECK : PLUS)),
      h("div", { class: "jrow-text" },
        h("div", { class: "srv-top" }, h("span", { class: "srv-title", text: c.title }), h("code", { class: "srv-name", text: c.name })),
        h("p", { class: "srv-desc", title: c.description, text: c.description }),
      ),
      h("span", { class: "pill" + (inIt ? " ok" : ""), text: inIt ? "Installed" : "Not installed" }),
    );
  });
  const have = st.catalog.filter((c) => c.installedIn.includes(a.id)).length;
  return h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("div", { class: "title-row" }, h("h1", { text: a.name }), h("span", { class: "pill" + (a.present ? " ok" : ""), text: a.present ? "Found" : "Not found" })),
        h("p", { text: a.present ? (a.cli ? "Found at " + a.cli : "Config folder found") : "Not found on this computer. JMCP can still write its config for when you install it." }),
      ),
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => api.reveal(a.configFile) }, "Show config file")),
    ),
    a.errors.map((e) => h("div", { class: "error-box", text: e })),
    h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", { text: "MCP servers in its config" }), h("span", { class: "mono note", title: a.configFile, text: a.configFile })),
      rows.length
        ? h("div", { class: "panel" }, h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", { text: "Name" }), h("th", { text: "Runs" }), h("th", { text: "Type" }), h("th", { text: "State" }), h("th", {}))), h("tbody", {}, rows)))
        : h("div", { class: "panel empty", text: a.name + " has no MCP servers in this file." }),
    ),
    h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", { text: "JMCP servers" }), h("span", { class: "note", text: have + " of " + st.catalog.length + " installed" })),
      removeView(),
      h("div", { class: "panel" }, jmcpRows),
      lastLog ? logView(lastLog) : null,
    ),
  );
}

function probeView(r) {
  if (!r.ok) return h("div", { class: "tool-list" }, h("span", { class: "state bad", text: r.error }));
  if (!r.tools.length) return h("div", { class: "tool-list" }, h("div", { text: "Started, but it offers no tools." }));
  return h("div", { class: "tool-list" }, h("div", { text: r.tools.length + " tools" + (r.server && r.server.version ? ", version " + r.server.version : "") }), r.tools.map((t) => h("div", {}, h("code", { text: t.name }), t.description.split(/(?<=\.)\s/)[0])));
}

async function runProbe(agentId, name) {
  const key = agentId + "/" + name;
  probes.set(key, { loading: true });
  render();
  try {
    probes.set(key, { result: await api.probe(agentId, name) });
  } catch (e) {
    probes.set(key, { result: { ok: false, error: e.message } });
  }
  render();
}

// ---- Activity ----

function ago(t) {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function statusClass(s) {
  return s === "done" || s === "ready" ? "ok" : s === "error" || s === "failed" ? "bad" : s === "busy" || s === "running" || s === "starting" ? "warn" : "";
}

function activityPage() {
  if (!act) {
    api.activity().then((r) => ((act = r), render())).catch((e) => ((act = { error: e.message, sessions: [], subagents: [] }), render()));
    return h("div", { class: "page" }, head("Activity", "Subagents started through jmcp-subagents, newest first."), h("div", { class: "panel empty", text: "Loading activity…" }));
  }
  const list = act.subagents.length
    ? h("div", { class: "panel act" },
        h("div", { class: "act-row act-head", "aria-hidden": "true" }, h("span", { text: "Status" }), h("span", { text: "Subagent" }), h("span", { text: "Task" }), h("span", { class: "when", text: "Updated" })),
        act.subagents.map((s) => {
          const key = s.session + "/" + s.handle;
          const open = openAct === key;
          const row = h("button", { class: "act-row" + (open ? " open" : ""), "aria-expanded": open ? "true" : "false", "data-focus-key": "act-" + key, onclick: () => ((openAct = open ? "" : key), render()) },
            h("span", {}, h("span", { class: "pill " + statusClass(s.status), text: s.status })),
            h("span", { class: "who-col" }, h("span", { class: "who-handle", text: s.handle }), h("span", { class: "who-from", text: "from " + (s.parent || "an agent") })),
            h("span", { class: "task", title: s.task, text: s.task }),
            h("span", { class: "when", text: ago(s.updated_at) }),
          );
          if (!open) return row;
          return [
            row,
            h("div", { class: "transcript" },
              h("div", { class: "msg" }, h("span", { class: "who", text: "Provider" }), h("span", { class: "text", text: s.provider_name + (s.model ? ", " + s.model : "") + " in " + s.cwd })),
              s.error ? h("div", { class: "msg" }, h("span", { class: "who", text: "Error" }), h("span", { class: "text state bad", text: s.error })) : null,
              s.rows.map((r) => h("div", { class: "msg " + r.role }, h("span", { class: "who", text: r.role === "user" ? "Task" : r.role === "assistant" ? "Reply" : r.role }), h("span", { class: "text", text: r.text }))),
            ),
          ];
        }),
      )
    : h("div", { class: "panel empty", text: "No subagents yet. When an agent uses jmcp-subagents, its subagents show here." });
  return h("div", { class: "page" },
    head("Activity", "Subagents started through jmcp-subagents, newest first. Click one to read its transcript.", [h("button", { class: "btn", onclick: () => ((act = null), render()) }, "Refresh")]),
    act.error ? h("div", { class: "error-box", text: act.error }) : null,
    list,
  );
}

// ---- Render ----

function render() {
  if (!st) return;
  const active = document.activeElement;
  const focusKey = active && active.closest("#main, .side") && active.dataset.focusKey;
  const start = focusKey && typeof active.selectionStart === "number" ? active.selectionStart : null;
  const end = focusKey && typeof active.selectionEnd === "number" ? active.selectionEnd : null;
  const scroll = $main.scrollTop;
  renderSide();
  const view = page === "rules" ? rulesPage() : page === "instructions" ? instructionsPage() : page === "memory" ? memoryPage() : page === "skills" ? skillsPage() : page === "activity" ? activityPage() : page === "health" ? healthPage() : page.startsWith("agent:") ? agentPage(page.slice(6)) : catalogPage();
  $main.replaceChildren(view);
  if (focusKey) {
    const next = [...document.querySelectorAll("[data-focus-key]")].find((x) => x.dataset.focusKey === focusKey);
    if (next) {
      next.focus();
      if (start !== null && typeof next.setSelectionRange === "function") next.setSelectionRange(start, end);
    }
  }
  $main.scrollTop = scroll;
}

async function load() {
  try {
    st = await api.state();
    render();
    // Updates made at start can take a while (the server is copied); show
    // them when they land.
    const done = await api.startupUpdates();
    if (done.length) {
      updates = done.map((u) => Object.assign({ atStart: true }, u));
      st = await api.state();
      render();
    }
  } catch (e) {
    $main.replaceChildren(h("div", { class: "page" }, head("JMCP could not read your agents", ""), h("div", { class: "error-box", text: e.message })));
  }
  document.documentElement.dataset.ready = "1";
}

window.addEventListener("focus", () => {
  if (!busy) api.state().then((s) => ((st = s), render())).catch(() => {});
});

load();
