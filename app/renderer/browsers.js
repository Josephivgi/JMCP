"use strict";

// Browsers page: the headless browsers agents have open through jmcp-browser,
// with a live view of each. Loaded after app.js and uses its helpers (h,
// head, icon, render, ago, api, page, serverStrip).
//
// The view refreshes by swapping each <img> source in place, so the page is
// only rebuilt when a browser opens, closes or changes page.

const br = {
  list: null, error: "", sig: "",
  shots: new Map(), // id -> data URL
  shotErr: new Map(), // id -> message
  big: "", ask: "", busy: "", closeErr: "",
  shooting: false,
};

function openBrowsers() {
  return br.list ? br.list.open.length : 0;
}

// What the page shows apart from the images; a change means a re-render.
function browserSig(l) {
  return JSON.stringify([l.open.map((b) => [b.id, b.title, b.url, b.lastAction]), l.recent.map((b) => b.id)]);
}

async function loadBrowsers() {
  try {
    const l = await api.browser.list();
    br.list = l;
    br.error = "";
    for (const id of [...br.shots.keys()]) if (!l.open.some((b) => b.id === id)) br.shots.delete(id);
    const sig = browserSig(l);
    const changed = sig !== br.sig;
    br.sig = sig;
    return changed;
  } catch (e) {
    const changed = br.error !== e.message;
    br.error = e.message;
    return changed;
  }
}

// One screenshot per open browser, set on its <img> directly.
async function refreshShots() {
  if (br.shooting || !br.list) return;
  br.shooting = true;
  try {
    for (const b of br.list.open) {
      try {
        const url = await api.browser.shot(b.id);
        br.shots.set(b.id, url);
        br.shotErr.delete(b.id);
      } catch (e) {
        br.shotErr.set(b.id, e.message);
      }
      const img = [...document.querySelectorAll("img[data-shot]")].find((x) => x.dataset.shot === b.id);
      if (img && br.shots.has(b.id) && img.src !== br.shots.get(b.id)) {
        img.src = br.shots.get(b.id);
        img.closest(".br-view").classList.remove("waiting");
      }
      const note = [...document.querySelectorAll("[data-shot-err]")].find((x) => x.dataset.shotErr === b.id);
      if (note) note.textContent = br.shotErr.get(b.id) || "";
    }
  } finally {
    br.shooting = false;
  }
}

// The open count in the sidebar stays current on every page; the views only
// refresh while the Browsers page is open.
setInterval(async () => {
  if (document.hidden || !st) return;
  const changed = await loadBrowsers();
  if (changed && !br.busy) render();
  if (page === "browsers") refreshShots();
}, 2000);
setTimeout(() => loadBrowsers().then((changed) => changed && st && render()), 400);

async function closeBrowser(id) {
  br.busy = id;
  br.closeErr = "";
  render();
  try {
    await api.browser.close(id);
    br.ask = "";
    if (br.big === id) br.big = "";
  } catch (e) {
    br.closeErr = e.message;
  }
  br.busy = "";
  await loadBrowsers();
  render();
}

function programName(p) {
  return /msedge/i.test(p) ? "Edge" : /chrom/i.test(p) ? "Chrome" : "Browser";
}

function browserCard(b) {
  const big = br.big === b.id;
  const shot = br.shots.get(b.id);
  const img = h("img", { "data-shot": b.id, alt: "Live view of " + (b.title || b.url || b.name) });
  if (shot) img.src = shot;
  const asking = br.ask === b.id;
  return h("article", { class: "panel br-card" + (big ? " big" : "") },
    h("div", { class: "br-view" + (shot ? "" : " waiting") }, img, h("span", { class: "br-wait", text: "Loading view…" })),
    h("div", { class: "br-body" },
      h("div", { class: "br-title-row" },
        h("span", { class: "dot" }),
        h("span", { class: "br-title", title: b.title, text: b.title || "(no title)" }),
      ),
      h("div", { class: "br-url mono", title: b.url, text: b.url || "about:blank" }),
      h("div", { class: "br-meta" },
        h("span", { class: "tag", text: b.agent }),
        h("span", { text: b.name + " · " + programName(b.program) + " · opened " + ago(b.startedAt) }),
      ),
      b.cwd ? h("div", { class: "br-cwd mono", title: b.cwd, text: b.cwd }) : null,
      b.lastAction ? h("div", { class: "br-last" }, h("span", { class: "br-last-label", text: "Last action" }), h("span", { text: b.lastAction + " · " + ago(b.updatedAt) })) : null,
      h("div", { class: "br-shot-err hint", "data-shot-err": b.id, text: br.shotErr.get(b.id) || "" }),
      asking
        ? h("div", { class: "warn-box br-ask", role: "alert" },
            h("span", { text: "Close this browser? The agent loses the page it is on and gets told it was closed." }),
            h("div", { class: "row-actions" },
              h("button", { class: "btn small danger", disabled: br.busy === b.id, "data-focus-key": "br-yes-" + b.id, onclick: () => closeBrowser(b.id) }, br.busy === b.id ? "Closing…" : "Close browser"),
              h("button", { class: "btn small quiet", disabled: br.busy === b.id, onclick: () => ((br.ask = ""), render()) }, "Cancel"),
            ),
            br.closeErr ? h("span", { class: "bad", text: br.closeErr }) : null,
          )
        : h("div", { class: "row-actions" },
            h("button", { class: "btn small", "data-focus-key": "br-big-" + b.id, onclick: () => ((br.big = big ? "" : b.id), render()) }, big ? "Smaller view" : "Larger view"),
            h("button", { class: "btn small quiet danger", "data-focus-key": "br-close-" + b.id, onclick: () => { br.ask = b.id; br.closeErr = ""; render(); focusLater("br-yes-" + b.id); } }, "Close"),
          ),
    ),
  );
}

function recentList(list) {
  if (!list.length) return null;
  return h("section", { class: "hl-section" },
    h("div", { class: "hl-section-head" }, h("h2", { text: "Recently closed" })),
    h("div", { class: "panel br-recent" },
      list.map((b) => h("div", { class: "br-recent-row" },
        h("span", { class: "tag", text: b.agent }),
        h("span", { class: "br-recent-page", title: b.url, text: (b.title || b.url || "about:blank") }),
        h("span", { class: "hint", text: b.closedReason }),
        h("span", { class: "when", text: ago(b.closedAt) }),
      )),
    ),
  );
}

function browsersPage() {
  if (!br.list && !br.error) loadBrowsers().then(() => (render(), refreshShots()));
  const l = br.list;
  return h("div", { class: "page br-page" },
    head("Browsers", "The browsers your agents have open through jmcp-browser. They run hidden; the view here updates every 2 seconds."),
    serverStrip("browser", "Agents open one with browser_open. A running agent gets the server in its next session."),
    br.error ? h("div", { class: "error-box", role: "alert", text: br.error }) : null,
    !l ? h("div", { class: "panel empty", text: "Loading browsers…" })
      : l.open.length ? h("div", { class: "br-grid" }, l.open.map(browserCard))
      : h("div", { class: "panel hl-empty" },
          h("p", { class: "hl-empty-title", text: "No browsers open" }),
          h("p", { class: "hint", text: "When an agent opens a browser with jmcp-browser, it shows here with a live view of the page. It closes when the agent is done or its session ends." }),
        ),
    l ? recentList(l.recent) : null,
  );
}
