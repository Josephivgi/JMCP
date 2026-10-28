"use strict";

// Connections page: other apps JMCP works with. Connecting an app adds
// JMCP to it (for JAgents Terminal, a plugin with subagents, a JMCP view and
// a jmcp MCP server). Loaded after app.js and uses its helpers (h, head,
// icon, render, ago, api, WARN).

const cn = { list: null, atStart: [], error: "", busy: "", ask: "", result: null };

function loadConnections() {
  api.connections
    .list()
    .then((r) => {
      cn.list = r.apps;
      cn.atStart = r.atStart || [];
      cn.error = "";
      render();
    })
    .catch((e) => {
      cn.list = cn.list || [];
      cn.error = e.message;
      render();
    });
}

function connectionAct(id, connect) {
  cn.busy = id;
  cn.ask = "";
  cn.result = null;
  render();
  (connect ? api.connections.connect(id) : api.connections.disconnect(id))
    .then((a) => {
      cn.result = { ok: true, text: connect ? a.name + " is connected. Open its Plugins menu (Ctrl+B e) and look for the JMCP commands." : a.name + " is disconnected. The JMCP plugin was removed from it." };
    })
    .catch((e) => {
      cn.result = { ok: false, text: e.message };
    })
    .finally(() => {
      cn.busy = "";
      cn.list = null;
      render();
    });
}

function connectionState(a) {
  if (!a.present) return h("span", { class: "state", text: "Not installed on this computer" });
  if (a.state === "connected" && a.pluginMissing) return h("span", { class: "state warn" }, icon(WARN), "The JMCP plugin was removed in " + a.name);
  if (a.state === "connected") return h("span", { class: "state", text: "Connected" + (a.auto ? " by itself" : "") + (a.lastSeen ? ", last seen " + ago(a.lastSeen) : ", waiting for " + a.name + " to load it") });
  if (a.state === "disconnected") return h("span", { class: "state", text: "Disconnected" });
  return h("span", { class: "state", text: "Not connected" });
}

function connectionCard(a) {
  const on = a.state === "connected" && !a.pluginMissing;
  const busyHere = cn.busy === a.id;
  const asking = cn.ask === a.id;
  return h("div", { class: "panel panel-pad conn" },
    h("div", { class: "conn-top" },
      h("div", { class: "conn-main" },
        h("div", { class: "srv-top" }, h("span", { class: "srv-title", text: a.name }), a.pluginVersion ? h("span", { class: "srv-ver", text: "plugin v" + a.pluginVersion }) : null),
        h("p", { class: "conn-desc", text: a.description }),
        connectionState(a),
      ),
      h("div", { class: "row-actions" },
        busyHere ? h("span", { class: "state", text: on ? "Disconnecting…" : "Connecting…" }) : null,
        !busyHere && on && !asking ? h("button", { class: "btn", disabled: Boolean(cn.busy), "data-focus-key": "conn-off-" + a.id, onclick: () => ((cn.ask = a.id), render()) }, "Disconnect") : null,
        !busyHere && !on && a.present ? h("button", { class: "btn primary", disabled: Boolean(cn.busy), "data-focus-key": "conn-on-" + a.id, onclick: () => connectionAct(a.id, true) }, a.pluginMissing ? "Connect again" : "Connect") : null,
      ),
    ),
    asking
      ? h("div", { class: "warn-box conn-ask" },
          h("span", { text: "Disconnect " + a.name + "? JMCP removes its plugin from " + a.name + ". Agents in open panes lose the jmcp tools. It stays disconnected until you connect it again." }),
          h("div", { class: "row-actions" },
            h("button", { class: "btn danger", onclick: () => connectionAct(a.id, false) }, "Disconnect"),
            h("button", { class: "btn", "data-focus-key": "conn-cancel-" + a.id, onclick: () => ((cn.ask = ""), render()) }, "Cancel"),
          ),
        )
      : null,
    h("div", { class: "conn-can" },
      h("div", { class: "field-label", text: on ? "What it can do" : "What it can do once connected" }),
      h("ul", { class: "box-list" }, a.can.map((c) => h("li", { text: c }))),
    ),
    h("p", { class: "conn-path faint", title: a.pluginDir, text: a.pluginDir }),
  );
}

function connectionsPage() {
  if (!cn.list && !cn.busy) {
    loadConnections();
    return h("div", { class: "page" }, head("Connections", "Apps that use JMCP."), h("div", { class: "panel empty", text: "Loading connections…" }));
  }
  const failed = cn.atStart.filter((x) => !x.ok);
  const auto = cn.atStart.filter((x) => x.ok && x.action === "connected");
  return h("div", { class: "page" },
    head("Connections", "Apps that use JMCP. A connected app can list subagents and use your JMCP servers from inside it.", [h("button", { class: "btn", disabled: Boolean(cn.busy), onclick: () => ((cn.list = null), render()) }, "Refresh")]),
    cn.error ? h("div", { class: "error-box", text: cn.error }) : null,
    cn.result ? h("div", { class: cn.result.ok ? "ok-box" : "error-box", text: cn.result.text }) : null,
    auto.map((x) => h("div", { class: "ok-box", text: x.connection.name + " was connected by itself when JMCP started." })),
    failed.map((x) => h("div", { class: "error-box", text: "Could not connect " + x.app + ": " + x.error })),
    h("div", { class: "conn-list" }, (cn.list || []).map(connectionCard)),
  );
}
