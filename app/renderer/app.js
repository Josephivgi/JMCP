"use strict";

// JMCP window. Pages: JMCP servers (install into agents), Activity (what
// jmcp-subagents has run), and one page per agent with the servers in its
// own config.

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
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const PAGES = [
  { id: "catalog", label: "JMCP servers", icon: "M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" },
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
  pages.replaceChildren(...PAGES.map((p) => h("button", { class: "nav-item" + (page === p.id ? " on" : ""), onclick: () => go(p.id) }, icon(p.icon), h("span", { class: "grow", text: p.label }))));
  const list = document.getElementById("nav-agents");
  list.replaceChildren(
    ...st.agents.map((a) =>
      h(
        "button",
        { class: "nav-item" + (page === "agent:" + a.id ? " on" : "") + (a.present ? "" : " absent"), onclick: () => go("agent:" + a.id), title: a.present ? a.name : a.name + " was not found on this computer" },
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

function agentName(id) {
  const a = st.agents.find((x) => x.id === id);
  return a ? a.name : id;
}

// ---- JMCP servers ----

function catalogPage() {
  const present = st.agents.filter((a) => a.present).map((a) => a.id);
  if (!picked) picked = new Set(present);
  const items = st.catalog.map((c) => {
    const installed = new Set(c.installedIn);
    const targets = h(
      "div",
      { class: "targets" },
      st.agents.map((a) => {
        const box = h("input", { type: "checkbox", checked: picked.has(a.id), onchange: (e) => (e.target.checked ? picked.add(a.id) : picked.delete(a.id), render()) });
        return h(
          "label",
          { class: "target" + (a.present ? "" : " absent") },
          box,
          h("span", { class: "grow", text: a.name }),
          installed.has(a.id) ? h("span", { class: "state ok", text: "Installed" }) : a.present ? null : h("span", { class: "state", text: "Not found" }),
        );
      }),
    );
    const n = picked.size;
    const inPicked = [...picked].filter((id) => installed.has(id));
    return h(
      "section",
      { class: "panel panel-pad" },
      h(
        "div",
        { class: "server-top" },
        h(
          "div",
          {},
          h("div", { class: "server-title" }, h("h2", { text: c.title }), h("code", { text: c.name }), c.official ? h("span", { class: "tag", text: "Official" }) : null),
          h("p", { class: "server-desc", text: c.description }),
        ),
        h(
          "div",
          { class: "server-side" },
          h("span", { class: "state" + (installed.size ? " ok" : ""), text: installed.size ? "In " + installed.size + " of " + st.agents.length + " agents" : "Not installed" }),
          h("span", { class: "state" + (c.updateAvailable ? " warn" : ""), text: c.updateAvailable ? "Update: " + c.installed + " to " + c.latest : c.installed ? "Version " + c.installed : "Version " + c.latest }),
          c.updateAvailable ? h("button", { class: "btn small", disabled: busy, onclick: () => runUpdate(c.id) }, "Update") : null,
        ),
      ),
      updateNote(c),
      h("div", { class: "tools" }, c.tools.map((t) => h("code", { text: t }))),
      h("div", { class: "section-head" }, h("h2", { text: "Install in" }), h("span", { class: "note", text: "Found agents are picked. Each config file is backed up before the first change." })),
      targets,
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn primary", disabled: busy || !n, onclick: () => runInstall(c.id, [...picked]) }, busy ? "Working…" : "Install in " + n + (n === 1 ? " agent" : " agents")),
        h("button", { class: "btn", disabled: busy || !inPicked.length, onclick: () => runUninstall(c.id, inPicked) }, "Remove from " + inPicked.length),
        h("button", { class: "btn quiet", disabled: busy, onclick: () => ((picked = new Set(present)), render()) }, "Pick found agents"),
      ),
      lastLog && lastLog.server === c.name ? logView(lastLog) : null,
    );
  });
  return h("div", { class: "page" }, head("JMCP servers", "MCP servers from JMCP. Install one and every agent you pick can use it."), items);
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

async function runInstall(id, ids) {
  busy = true;
  render();
  try {
    const r = await api.install(id, ids);
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

// ---- One agent ----

function agentPage(id) {
  const a = st.agents.find((x) => x.id === id);
  if (!a) return h("div", { class: "page" }, head("Not found", ""));
  const rows = a.servers.map((s) => {
    const key = a.id + "/" + s.name;
    const pr = probes.get(key);
    const where = s.url || [s.command].concat(s.args).join(" ");
    const envKeys = Object.keys(s.env || {});
    return h(
      "tr",
      {},
      h("td", { class: "name", text: s.name }),
      h("td", { class: "fit" }, h("span", { class: "tag", text: s.transport })),
      h(
        "td",
        { class: "cmd" },
        h("span", { class: "mono", title: where, text: where }),
        envKeys.length ? h("span", { class: "mono", text: "env: " + envKeys.join(", ") }) : null,
        pr && pr.result ? probeView(pr.result) : null,
      ),
      h("td", { class: "fit" }, h("span", { class: "state" + (s.enabled ? " ok" : ""), text: s.enabled ? "On" : "Off" })),
      h(
        "td",
        { class: "fit" },
        s.transport === "stdio" ? h("button", { class: "btn small", disabled: pr && pr.loading, onclick: () => runProbe(a.id, s.name) }, pr && pr.loading ? "Checking…" : "Check tools") : null,
      ),
    );
  });
  const jmcpRows = st.catalog.map((c) => {
    const inIt = c.installedIn.includes(a.id);
    return h(
      "div",
      { class: "server-top" },
      h("div", {}, h("div", { class: "server-title" }, h("h2", { text: c.title }), h("code", { text: c.name })), h("p", { class: "server-desc", text: c.description })),
      h(
        "div",
        { class: "row-actions" },
        inIt ? h("span", { class: "state ok", text: "Installed" }) : null,
        inIt
          ? h("button", { class: "btn", disabled: busy, onclick: () => runUninstall(c.id, [a.id]) }, "Remove")
          : h("button", { class: "btn primary", disabled: busy, onclick: () => runInstall(c.id, [a.id]) }, busy ? "Working…" : "Install"),
      ),
    );
  });
  return h(
    "div",
    { class: "page" },
    head(a.name, a.present ? (a.cli ? "Found at " + a.cli : "Config folder found") : "Not found on this computer. JMCP can still write its config for when you install it.", [
      h("button", { class: "btn", onclick: () => api.reveal(a.configFile) }, "Show config file"),
    ]),
    a.errors.map((e) => h("div", { class: "error-box", text: e })),
    h(
      "section",
      { class: "section" },
      h("div", { class: "section-head" }, h("h2", { text: "In " + a.name + "'s config" }), h("span", { class: "mono note", text: a.configFile })),
      rows.length
        ? h("div", { class: "panel" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Name" }), h("th", { text: "Type" }), h("th", { text: "Runs" }), h("th", { text: "State" }), h("th", {}))), h("tbody", {}, rows)))
        : h("div", { class: "panel empty", text: a.name + " has no MCP servers in this file." }),
    ),
    h("section", { class: "section" }, h("h2", { text: "JMCP servers" }), h("div", { class: "panel panel-pad" }, jmcpRows), lastLog ? logView(lastLog) : null),
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
    return h("div", { class: "page" }, head("Activity", "Loading…"));
  }
  const subs = act.subagents.length
    ? h(
        "div",
        { class: "panel act" },
        act.subagents.map((s) => {
          const key = s.session + "/" + s.handle;
          const row = h(
            "button",
            { class: "act-row", "aria-expanded": openAct === key ? "true" : "false", onclick: () => ((openAct = openAct === key ? "" : key), render()) },
            h("span", { class: "state " + statusClass(s.status), text: s.status }),
            h("span", { class: "who-col", text: s.handle + " · " + (s.parent || "agent") }),
            h("span", { class: "task", title: s.task, text: s.task }),
            h("span", { class: "when", text: ago(s.updated_at) }),
          );
          if (openAct !== key) return row;
          return [
            row,
            h(
              "div",
              { class: "transcript" },
              h("div", { class: "msg" }, h("span", { class: "who", text: "Provider" }), h("span", { class: "text", text: s.provider_name + (s.model ? ", " + s.model : "") + " in " + s.cwd })),
              s.error ? h("div", { class: "msg" }, h("span", { class: "who", text: "Error" }), h("span", { class: "text state bad", text: s.error })) : null,
              s.rows.map((r) => h("div", { class: "msg " + r.role }, h("span", { class: "who", text: r.role === "user" ? "Task" : r.role === "assistant" ? "Reply" : r.role }), h("span", { class: "text", text: r.text }))),
            ),
          ];
        }),
      )
    : h("div", { class: "panel empty", text: "No subagents yet. When an agent uses jmcp-subagents, its subagents show here." });
  return h(
    "div",
    { class: "page" },
    head("Activity", "Subagents started through jmcp-subagents, newest first.", [h("button", { class: "btn", onclick: () => ((act = null), render()) }, "Refresh")]),
    act.error ? h("div", { class: "error-box", text: act.error }) : null,
    h("section", { class: "section" }, h("h2", { text: "Subagents" }), subs),
  );
}

// ---- Render ----

function render() {
  if (!st) return;
  renderSide();
  const view = page === "activity" ? activityPage() : page.startsWith("agent:") ? agentPage(page.slice(6)) : catalogPage();
  $main.replaceChildren(view);
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
