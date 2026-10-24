"use strict";

// Memory and Skills pages. Loaded after app.js and uses its helpers
// (h, head, logView, render, ago, api, st, busy, serverStrip, focusLater).

// ---- Shared ----

// Same rule as the stores: "Prefers dark mode!" -> "prefers-dark-mode".
function slugOf(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// Run one change at a time, then reload the page's list. Errors show next to
// the form when one is open.
async function libChange(view, work, done) {
  if (busy) return;
  busy = true;
  view.error = "";
  render();
  try {
    const r = await work();
    if (done) done(r);
    await view.reload();
  } catch (e) {
    view.error = e.message;
  }
  busy = false;
  render();
  if (view.error) queueMicrotask(() => { const el = document.querySelector("#main .lib-error"); if (el) el.scrollIntoView({ block: "nearest" }); });
}

// Load the list on first visit, after a failed load (Retry), and whenever the
// page is opened again or the window gets focus, so agents' changes show up.
function ensureLoaded(view) {
  if ((view.list && !view.stale) || view.loading || view.loadError) return;
  view.stale = false;
  view.loading = view.reload()
    .then(() => { view.loadError = ""; })
    .catch((e) => { view.loadError = e.message; })
    .finally(() => { view.loading = null; render(); });
}

function loadFailed(view, what) {
  return h("div", { class: "error-box lib-load-error", role: "alert" },
    h("span", { text: "Could not load " + what + ": " + view.loadError }),
    h("button", { class: "btn small", onclick: () => { view.stale = true; view.loadError = ""; render(); } }, "Retry"),
  );
}

// The draft differs from what it started as.
function libDirty(view) {
  return Boolean(view.draft && view.base && Object.keys(view.draft).some((k) => view.draft[k] !== view.base[k]));
}

// Leave the open form, asking first when it has unsaved changes.
function leave(view, then) {
  if (busy) return;
  if (libDirty(view)) {
    view.leaving = then;
    render();
    focusLater(view.key + "-keep");
    return;
  }
  view.leaving = null;
  view.draft = view.base = null;
  then();
  render();
}

function leaveBar(view) {
  if (!view.leaving) return null;
  return h("div", { class: "warn-box", role: "alertdialog", "aria-label": "Unsaved changes", "aria-describedby": view.key + "-leave-text", onkeydown: (e) => { if (e.key === "Escape") { view.leaving = null; render(); } } },
    h("p", { id: view.key + "-leave-text", text: "You have unsaved changes. Discard them?" }),
    h("div", { class: "row-actions" },
      h("button", { class: "btn danger", type: "button", onclick: () => { const then = view.leaving; view.leaving = null; view.draft = view.base = null; view.error = ""; then(); render(); } }, "Discard changes"),
      h("button", { class: "btn", type: "button", "data-focus-key": view.key + "-keep", onclick: () => { view.leaving = null; render(); } }, "Keep editing"),
    ),
  );
}

function field(label, key, value, onInput, opts) {
  const o = opts || {};
  const attrs = {
    class: "lib-input" + (o.mono ? " mono" : ""),
    "aria-label": label,
    "data-focus-key": key,
    placeholder: o.placeholder,
    required: o.required,
    maxlength: o.max ? String(o.max) : null,
    disabled: busy,
    oninput: (e) => { onInput(e.target.value); if (o.live) render(); },
    onkeydown: o.onSubmit ? (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); o.onSubmit(); } } : null,
  };
  const input = o.rows ? h("textarea", Object.assign(attrs, { rows: String(o.rows) }), value) : h("input", Object.assign(attrs, { type: "text", value }));
  return h("label", { class: "lib-field" }, h("span", { class: "field-label", text: label }), input, o.hint ? h("span", { class: "hint", text: o.hint }) : null);
}

function formError(view) {
  return view.error ? h("div", { class: "error-box lib-error", role: "alert", text: view.error }) : null;
}

function matches(q, ...parts) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = parts.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

function searchBox(label, key, view, placeholder) {
  return h("input", { class: "lib-search", type: "search", placeholder, "aria-label": label, "data-focus-key": key, value: view.q, oninput: (e) => { view.q = e.target.value; render(); } });
}

// Keep the list's own scroll position across renders.
function keepScroll(el, view) {
  el.addEventListener("scroll", () => { view.listScroll = el.scrollTop; });
  queueMicrotask(() => { el.scrollTop = view.listScroll || 0; });
  return el;
}

function deleteConfirm(view, what, onDelete) {
  const cancel = () => { view.del = false; render(); focusLater(view.key + "-delete"); };
  return h("div", { class: "warn-box", role: "alertdialog", "aria-label": "Delete " + what, "aria-describedby": view.key + "-del-text", onkeydown: (e) => { if (e.key === "Escape") cancel(); } },
    h("p", { id: view.key + "-del-text", text: "Delete " + what + "? Agents lose it at once. This cannot be undone." }),
    h("div", { class: "row-actions" },
      h("button", { class: "btn danger", disabled: busy, onclick: onDelete }, "Delete " + what),
      h("button", { class: "btn", disabled: busy, "data-focus-key": view.key + "-del-cancel", onclick: cancel }, "Cancel"),
    ),
  );
}

// ---- Memory ----

const mem = {
  key: "mem", list: null, loading: null, stale: false, loadError: "", error: "", q: "", sel: "", mode: "view",
  draft: null, base: null, leaving: null, del: false, replace: false, installLog: null, listScroll: 0,
  async reload() { mem.list = await api.memory.list(); },
};

function memDraft(m) {
  return m ? { name: m.name, title: m.title, body: m.body, tags: m.tags.join(", ") } : { name: "", title: "", body: "", tags: "" };
}

function openMemoryForm(m) {
  leave(mem, () => {
    mem.mode = m ? "edit" : "new";
    mem.draft = memDraft(m);
    mem.base = memDraft(m);
    mem.del = false;
    mem.replace = false;
    mem.error = "";
  });
  if (!mem.leaving) focusLater("mem-title");
}

function memoryForm() {
  const d = mem.draft;
  const isNew = mem.mode === "new";
  const key = slugOf(d.name || d.title);
  const taken = mem.list.find((m) => m.name === key && (isNew || m.id !== mem.sel));
  const submit = () => {
    if (busy) return;
    if (!d.title.trim() || !d.body.trim()) { mem.error = "A memory needs a title and some text."; render(); return; }
    if (!key) { mem.error = "The name needs at least one letter or number."; render(); return; }
    const tags = d.tags.split(",");
    if (isNew) {
      if (taken && !mem.replace) { mem.error = "A memory named " + key + " already exists. Change the name, or press Replace it to overwrite it."; render(); return; }
      return libChange(mem, () => api.memory.save({ name: key, title: d.title, body: d.body, tags }), (m) => { mem.sel = m.id; mem.mode = "view"; mem.draft = mem.base = null; mem.replace = false; mem.q = ""; });
    }
    libChange(mem, () => api.memory.update(mem.sel, { name: key, title: d.title, body: d.body, tags }), (m) => {
      if (!m) {
        // An agent deleted it while it was open: keep the text as a new memory.
        mem.mode = "new";
        mem.base = memDraft(null);
        throw new Error("This memory was deleted while you edited it. Your text is still here; press Save memory to keep it as a new one.");
      }
      mem.mode = "view";
      mem.draft = mem.base = null;
      mem.q = "";
    });
  };
  return h("form", { class: "lib-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
    h("h2", { text: isNew ? "New memory" : "Edit memory" }),
    leaveBar(mem),
    formError(mem),
    isNew && taken && mem.replace ? h("div", { class: "warn-box" }, h("p", { text: "Saving replaces the memory \"" + taken.title + "\" (" + taken.name + ")." })) : null,
    isNew && taken && !mem.replace && mem.error ? h("div", { class: "row-actions" }, h("button", { class: "btn danger", type: "button", disabled: busy, onclick: () => { mem.replace = true; mem.error = ""; render(); } }, "Replace it")) : null,
    field("Title", "mem-title", d.title, (v) => { d.title = v; mem.replace = false; }, { placeholder: "Example: Prefers SQLite for local apps", required: true, max: 200, live: !d.name }),
    field("Memory", "mem-body", d.body, (v) => { d.body = v; }, { rows: 8, placeholder: "What agents should remember, and why it matters.", required: true, onSubmit: submit }),
    h("div", { class: "lib-row" },
      field("Name", "mem-name", d.name, (v) => { d.name = v; mem.replace = false; }, { mono: true, placeholder: "made from the title", max: 64, live: true, hint: key ? "Agents read it as " + key + (taken ? ". That name is already used." : ".") : "Agents read it by this name." }),
      field("Tags", "mem-tags", d.tags, (v) => { d.tags = v; }, { placeholder: "data, windows", hint: "Separate with commas." }),
    ),
    h("div", { class: "row-actions" },
      h("button", { class: "btn primary", type: "submit", disabled: busy }, busy ? "Working…" : isNew ? "Save memory" : "Save changes"),
      h("button", { class: "btn", type: "button", disabled: busy, onclick: () => leave(mem, () => { mem.mode = "view"; mem.error = ""; }) }, "Cancel"),
    ),
  );
}

function memoryDetail() {
  if (mem.mode !== "view") return memoryForm();
  const m = mem.list.find((x) => x.id === mem.sel);
  if (!m) {
    return h("div", { class: "lib-blank" },
      h("p", { class: "rule-empty-title", text: mem.list.length ? "Pick a memory to read it" : "No memories yet" }),
      h("p", { text: mem.list.length ? "Or add one yourself." : "Agents with jmcp-memory save what they learn here. You can add one too." }),
      h("button", { class: "btn primary", onclick: () => openMemoryForm(null) }, "New memory"),
    );
  }
  return h("div", { class: "lib-detail" },
    h("div", { class: "lib-detail-head" },
      h("div", {},
        h("h2", { class: "lib-title", text: m.title }),
        h("div", { class: "lib-meta" }, h("code", { text: m.name }), h("span", { text: "Saved by " + m.author + ", " + ago(m.updated_at) })),
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", disabled: busy, onclick: () => openMemoryForm(m) }, "Edit"),
        h("button", { class: "btn danger", disabled: busy, "data-focus-key": "mem-delete", onclick: () => { mem.del = true; render(); focusLater("mem-del-cancel"); } }, "Delete"),
      ),
    ),
    formError(mem),
    m.tags.length ? h("div", { class: "tools" }, m.tags.map((t) => h("code", { text: t }))) : null,
    mem.del ? deleteConfirm(mem, "this memory", () => libChange(mem, () => api.memory.remove(m.id), () => { mem.sel = ""; mem.del = false; })) : null,
    h("div", { class: "lib-body", text: m.body }),
  );
}

function memoryPage() {
  ensureLoaded(mem);
  const shown = mem.list ? mem.list.filter((m) => matches(mem.q, m.name, m.title, m.body, m.tags.join(" "))) : [];
  const current = (m) => m.id === mem.sel && mem.mode !== "new";
  return h("div", { class: "page" },
    head("Memory", "What agents remember across sessions. One agent saves it, every agent with jmcp-memory can find it."),
    serverStrip("memory", "Agents search and save memories as they work."),
    mem.loadError ? loadFailed(mem, "memories") : null,
    !mem.list ? (mem.loadError ? null : h("div", { class: "panel empty", text: "Loading memories…" })) :
    !mem.list.length ? h("section", { class: "panel lib-detail-panel" }, memoryDetail()) :
    h("div", { class: "lib-grid" },
      h("section", { class: "panel lib-list-panel", "aria-label": "Memories" },
        h("div", { class: "lib-list-head" },
          searchBox("Search memories", "mem-q", mem, "Search " + mem.list.length + (mem.list.length === 1 ? " memory" : " memories")),
          h("button", { class: "btn", disabled: busy, onclick: () => openMemoryForm(null) }, "New"),
        ),
        shown.length ? keepScroll(h("ul", { class: "lib-list" }, shown.map((m) =>
          h("li", {}, h("button", { class: "lib-item" + (current(m) ? " on" : ""), "aria-current": current(m) ? "true" : null, "data-focus-key": "mem-item-" + m.id, onclick: () => leave(mem, () => { mem.sel = m.id; mem.mode = "view"; mem.del = false; mem.error = ""; }) },
            h("span", { class: "lib-item-title", text: m.title }),
            h("span", { class: "lib-item-sub", text: m.name + " · " + m.author + " · " + ago(m.updated_at) }),
          )))), mem) :
        h("div", { class: "rule-empty" }, h("p", { text: mem.list.length ? "No memories match." : "No memories yet." })),
      ),
      h("section", { class: "panel lib-detail-panel" }, memoryDetail()),
    ),
  );
}

// ---- Skills ----

const sk = {
  key: "sk", list: null, loading: null, stale: false, loadError: "", error: "", q: "", sel: "", mode: "view",
  draft: null, base: null, leaving: null, del: false, installLog: null, listScroll: 0,
  found: null, picked: new Set(), importLog: null,
  async reload() { sk.list = await api.skills.list(); },
};

function skillDraft(s) {
  return s ? { name: s.name, description: s.description, body: s.body } : { name: "", description: "", body: "" };
}

function openSkillForm(s) {
  leave(sk, () => {
    sk.mode = s ? "edit" : "new";
    sk.draft = skillDraft(s);
    sk.base = skillDraft(s);
    sk.del = false;
    sk.error = "";
  });
  if (!sk.leaving) focusLater("sk-name");
}

function skillForm() {
  const d = sk.draft;
  const isNew = sk.mode === "new";
  const key = slugOf(d.name);
  const taken = sk.list.find((s) => s.name === key && (isNew || s.id !== sk.sel));
  const submit = () => {
    if (busy) return;
    if (!key || !d.description.trim() || !d.body.trim()) { sk.error = "A skill needs a name, a description and instructions."; render(); return; }
    if (taken) { sk.error = "A skill named " + key + " already exists. Pick another name."; render(); return; }
    const input = { name: key, description: d.description, body: d.body };
    if (isNew) return libChange(sk, () => api.skills.add(input), (s) => { sk.sel = s.id; sk.mode = "view"; sk.draft = sk.base = null; sk.q = ""; });
    libChange(sk, () => api.skills.update(sk.sel, input), (s) => {
      if (!s) {
        sk.mode = "new";
        sk.base = skillDraft(null);
        throw new Error("This skill was deleted while you edited it. Your text is still here; press Add skill to keep it.");
      }
      sk.mode = "view";
      sk.draft = sk.base = null;
      sk.q = "";
    });
  };
  const s = sk.list.find((x) => x.id === sk.sel);
  return h("form", { class: "lib-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
    h("h2", { text: isNew ? "New skill" : "Edit skill" }),
    leaveBar(sk),
    formError(sk),
    !isNew && s && s.origin ? h("p", { class: "hint", text: "Imported from " + s.origin + ". Edits change the JMCP copy only, not that file." }) : null,
    field("Name", "sk-name", d.name, (v) => { d.name = v; }, { mono: true, placeholder: "release-notes", required: true, max: 64, live: true, hint: key ? "Saved as " + key + (taken ? ". That name is already used." : ".") : "Lowercase words joined by dashes." }),
    field("When to use it", "sk-desc", d.description, (v) => { d.description = v; }, { rows: 3, required: true, max: 2000, placeholder: "Use when writing release notes for a GitHub release.", hint: "Agents read this to decide when to load the skill. Be specific." }),
    field("Instructions", "sk-body", d.body, (v) => { d.body = v; }, { rows: 14, mono: true, required: true, placeholder: "# Release notes\n\nSteps the agent should follow…", onSubmit: submit }),
    h("div", { class: "row-actions" },
      h("button", { class: "btn primary", type: "submit", disabled: busy }, busy ? "Working…" : isNew ? "Add skill" : "Save changes"),
      h("button", { class: "btn", type: "button", disabled: busy, onclick: () => leave(sk, () => { sk.mode = "view"; sk.error = ""; }) }, "Cancel"),
    ),
  );
}

// Pick new skills, one file per name (the first one found).
function defaultPicks(found) {
  const names = new Set();
  const picks = new Set();
  for (const f of found) {
    if (f.state !== "new" || names.has(f.name)) continue;
    names.add(f.name);
    picks.add(f.file);
  }
  return picks;
}

async function loadImportable(keepLog) {
  sk.found = null;
  if (!keepLog) sk.importLog = null;
  render();
  try {
    sk.found = await api.skills.importable();
    sk.picked = defaultPicks(sk.found);
  } catch (e) {
    sk.found = [];
    sk.error = e.message;
  }
  render();
}

function openImport() {
  leave(sk, () => { sk.mode = "import"; sk.del = false; sk.error = ""; loadImportable(false); });
}

function importView() {
  if (!sk.found) return h("div", { class: "lib-blank" }, h("p", { text: "Looking for skills in your agents' folders…" }));
  const head2 = h("div", { class: "lib-detail-head" },
    h("div", {}, h("h2", { text: "Import skills" }), h("p", { class: "note", text: "SKILL.md folders found in your agents' skill folders. Imported skills are copied into JMCP; the files stay where they are." })),
    h("button", { class: "btn", disabled: busy, onclick: () => { sk.mode = "view"; render(); } }, "Close"),
  );
  if (!sk.found.length) return h("div", { class: "lib-detail" }, head2, formError(sk), h("div", { class: "rule-empty" }, h("p", { text: "No SKILL.md files found in Claude Code, Codex, Droid, Cursor, Gemini, OpenCode, Grok or .agents skill folders." })));
  const groups = [...new Set(sk.found.map((f) => f.agent))];
  const n = sk.picked.size;
  const count = {};
  for (const f of sk.found) count[f.name] = (count[f.name] || 0) + 1;
  const status = (f) => f.state === "imported" ? ["ok", "Imported. Importing again updates it."] : f.state === "taken" ? ["", "A different skill has this name"] : f.state === "error" ? ["bad", "Can't read"] : count[f.name] > 1 ? ["warn", "Same name in another folder"] : null;
  const pick = (f, on) => {
    if (on) {
      // One file per name: picking this one drops the others with its name.
      for (const g of sk.found) if (g.name === f.name) sk.picked.delete(g.file);
      sk.picked.add(f.file);
    } else sk.picked.delete(f.file);
    render();
  };
  return h("div", { class: "lib-detail" },
    head2,
    formError(sk),
    groups.map((g) => {
      const items = sk.found.filter((f) => f.agent === g);
      return h("div", { class: "import-group" },
        h("div", { class: "section-head" }, h("h2", { text: g }), h("span", { class: "mono note", title: items[0].root, text: items[0].root })),
        items.map((f) => {
          const st2 = status(f);
          return h("label", { class: "import-item" + (f.state === "error" || f.state === "taken" ? " absent" : ""), title: f.file },
            h("input", { type: "checkbox", "aria-label": "Import " + f.name + " from " + g, "data-focus-key": "imp-" + f.file, checked: sk.picked.has(f.file), disabled: busy || f.state === "error" || f.state === "taken", onchange: (e) => pick(f, e.target.checked) }),
            h("span", { class: "import-text" }, h("code", { text: f.name }), h("span", { class: "lib-item-sub", text: f.error || f.description })),
            st2 ? h("span", { class: "state" + (st2[0] ? " " + st2[0] : ""), text: st2[1] }) : null,
          );
        }),
      );
    }),
    h("div", { class: "row-actions lib-sticky" },
      h("button", { class: "btn primary", disabled: busy || !n, onclick: () => {
        const files = [...sk.picked];
        libChange(sk, () => api.skills.import(files), (r) => { sk.importLog = r; }).then(() => loadImportable(true));
      } }, busy ? "Working…" : "Import " + n + (n === 1 ? " skill" : " skills")),
      h("button", { class: "btn quiet", disabled: busy || !n, onclick: () => { sk.picked = new Set(); render(); } }, "Clear"),
    ),
    sk.importLog ? h("ul", { class: "log" }, sk.importLog.map((x) => h("li", {},
      h("span", { class: "state " + (x.ok ? "ok" : "bad"), text: x.ok ? (x.updated ? "Updated" : "Imported") : "Skipped" }),
      h("span", { text: x.name || "" }),
      h("span", { class: "mono", text: x.ok ? x.file : x.error }),
    ))) : null,
  );
}

function skillDetail() {
  if (sk.mode === "import") return importView();
  if (sk.mode !== "view") return skillForm();
  const s = sk.list.find((x) => x.id === sk.sel);
  if (!s) {
    return h("div", { class: "lib-blank" },
      h("p", { class: "rule-empty-title", text: sk.list.length ? "Pick a skill to see it" : "No skills yet" }),
      h("p", { text: "Write a skill, or import the ones your agents already have." }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn primary", onclick: () => openSkillForm(null) }, "New skill"),
        h("button", { class: "btn", onclick: openImport }, "Import skills"),
      ),
    );
  }
  return h("div", { class: "lib-detail" },
    h("div", { class: "lib-detail-head" },
      h("div", {},
        h("div", { class: "server-title" }, h("h2", { class: "lib-title mono", text: s.name }), s.enabled ? null : h("span", { class: "tag", text: "Off" })),
        h("div", { class: "lib-meta" }, h("span", { text: s.origin ? "Imported from " + s.origin : "Made in JMCP" }), h("span", { text: "Changed " + ago(s.updated_at) })),
      ),
      h("div", { class: "row-actions" },
        h("button", { class: "btn", disabled: busy, onclick: () => openSkillForm(s) }, "Edit"),
        s.origin ? h("button", { class: "btn quiet", onclick: () => api.reveal(s.origin) }, "Show file") : null,
        h("button", { class: "btn danger", disabled: busy, "data-focus-key": "sk-delete", onclick: () => { sk.del = true; render(); focusLater("sk-del-cancel"); } }, "Delete"),
      ),
    ),
    formError(sk),
    sk.del ? deleteConfirm(sk, "this skill", () => libChange(sk, () => api.skills.remove(s.id), () => { sk.sel = ""; sk.del = false; })) : null,
    h("div", { class: "lib-field" }, h("span", { class: "field-label", text: "When to use it" }), h("p", { class: "lib-desc", text: s.description })),
    h("div", { class: "lib-field" }, h("span", { class: "field-label", text: "Instructions" }), h("pre", { class: "lib-body mono", text: s.body })),
  );
}

function skillsPage() {
  ensureLoaded(sk);
  const shown = sk.list ? sk.list.filter((s) => matches(sk.q, s.name, s.description)) : [];
  const on = sk.list ? sk.list.filter((s) => s.enabled).length : 0;
  const current = (s) => s.id === sk.sel && sk.mode !== "new" && sk.mode !== "import";
  return h("div", { class: "page" },
    head("Skills", "One skills library for every agent. Agents see each skill's description and load it when a task matches."),
    serverStrip("skills", "Running agents see changes the next time they list or load skills."),
    sk.loadError ? loadFailed(sk, "skills") : null,
    !sk.list ? (sk.loadError ? null : h("div", { class: "panel empty", text: "Loading skills…" })) :
    !sk.list.length ? h("section", { class: "panel lib-detail-panel" }, skillDetail()) :
    h("div", { class: "lib-grid" },
      h("section", { class: "panel lib-list-panel", "aria-label": "Skills" },
        h("div", { class: "lib-list-head" },
          searchBox("Search skills", "sk-q", sk, "Search " + sk.list.length + (sk.list.length === 1 ? " skill" : " skills")),
          h("button", { class: "btn", disabled: busy, onclick: () => openSkillForm(null) }, "New"),
        ),
        h("div", { class: "lib-list-sub" },
          h("span", { class: "hint", text: on + " of " + sk.list.length + " on" }),
          h("button", { class: "btn small quiet", disabled: busy, onclick: openImport }, "Import from agents"),
        ),
        shown.length ? keepScroll(h("ul", { class: "lib-list" }, shown.map((s) =>
          h("li", { class: "lib-item lib-item-row" + (current(s) ? " on" : "") },
            // Not disabled while busy: a disabled switch drops keyboard focus.
            h("label", { class: "switch", title: s.enabled ? "On: agents can load this skill" : "Off: agents do not see this skill" },
              h("input", { type: "checkbox", role: "switch", checked: s.enabled, "aria-busy": busy ? "true" : null, "aria-label": "Skill " + s.name + " on", "data-focus-key": "sk-toggle-" + s.id, onclick: (e) => { if (busy) e.preventDefault(); }, onchange: (e) => libChange(sk, () => api.skills.update(s.id, { enabled: e.target.checked })) }),
              h("span", { class: "switch-track", "aria-hidden": "true" }),
            ),
            h("button", { class: "lib-item-main", "aria-current": current(s) ? "true" : null, "data-focus-key": "sk-item-" + s.id, onclick: () => leave(sk, () => { sk.sel = s.id; sk.mode = "view"; sk.del = false; sk.error = ""; }) },
              h("span", { class: "lib-item-title mono" }, h("span", { class: "lib-item-name", text: s.name }), s.enabled ? null : h("span", { class: "tag lib-off", text: "Off" })),
              h("span", { class: "lib-item-sub", text: s.description }),
            ),
          ))), sk) :
        h("div", { class: "rule-empty" }, h("p", { text: sk.list.length ? "No skills match." : "No skills yet." })),
      ),
      h("section", { class: "panel lib-detail-panel" }, skillDetail()),
    ),
  );
}

// Opening the page again or coming back to the window shows agents' changes.
function markStale() {
  mem.stale = true;
  sk.stale = true;
  rulesStale = true;
  insStale = true;
}
document.getElementById("nav-pages").addEventListener("click", markStale, true);
window.addEventListener("focus", markStale);
