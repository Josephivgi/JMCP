"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("jmcp", {
  state: () => call("state"),
  install: (id, agentIds, force) => call("install", id, agentIds, force),
  installAll: () => call("install-all"),
  uninstall: (id, agentIds) => call("uninstall", id, agentIds),
  update: (id) => call("update", id),
  startupUpdates: () => call("startup-updates"),
  probe: (agentId, name) => call("probe", agentId, name),
  activity: () => call("activity"),
  rules: {
    list: () => call("rules-list"),
    add: (input) => call("rules-add", input),
    update: (id, patch) => call("rules-update", id, patch),
    remove: (id) => call("rules-remove", id),
    preview: () => call("rules-preview"),
  },
  instructions: {
    list: () => call("instructions-list"),
    detect: () => call("instructions-detect"),
    read: (file) => call("instructions-read", file),
    write: (file, text, expectedHash) => call("instructions-write", file, text, expectedHash),
    remove: (file) => call("instructions-remove", file),
    addFolder: (folder) => call("instructions-add-folder", folder),
    removeFolder: (folder) => call("instructions-remove-folder", folder),
    trash: () => call("instructions-trash"),
    trashText: (id) => call("instructions-trash-text", id),
    restore: (id) => call("instructions-restore", id),
    forget: (id) => call("instructions-forget", id),
  },
  pickFolder: () => call("pick-folder"),
  memory: {
    list: () => call("memory-list"),
    save: (input) => call("memory-save", input),
    update: (id, patch) => call("memory-update", id, patch),
    remove: (id) => call("memory-remove", id),
  },
  skills: {
    list: () => call("skills-list"),
    add: (input) => call("skills-add", input),
    update: (id, patch) => call("skills-update", id, patch),
    remove: (id) => call("skills-remove", id),
    importable: () => call("skills-importable"),
    import: (files) => call("skills-import", files),
  },
  health: {
    local: () => call("health-local"),
    ssh: () => call("health-ssh"),
    host: (name) => call("health-host", name),
    full: (target) => call("health-full", target),
    update: (name, opts) => call("health-update", name, opts),
    notes: (opts) => call("health-notes", opts),
    dismiss: (id, back) => call("health-note-dismiss", id, back),
    dismissAll: () => call("health-notes-dismiss-all"),
    remove: (id) => call("health-note-remove", id),
  },
  reveal: (file) => call("reveal", file),
});
