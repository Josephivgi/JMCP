# JMCP agent instructions

JMCP is an Electron app plus a set of stdio MCP servers that it installs into every coding agent on this computer (Claude Code, Codex, Factory Droid, Cursor, Gemini CLI, Qwen Code, Grok, OpenCode, Devin).

## Layout

- `app/`: Electron app. `main.cjs` (IPC handlers), `preload.cjs`, `updater.cjs` (updates from GitHub Releases), `renderer/*.js` (pages; build DOM with the `h()` helper and text nodes, never `innerHTML` with data).
- `core/`: shared logic. `catalog.cjs` lists JMCP servers and installs/updates them, `agents.cjs` edits each agent's MCP config (JSON/JSONC/TOML in place, `.jmcp-backup` on first change, never writes a TOML file that no longer parses).
- `servers/<id>/`: one MCP server each (`subagents`, `rules`, `instructions`, `memory`, `skills`, `health`, `browser`). Each has `server.cjs`, `lib/`, `package.json` (its version) and `README.md`.
- `cli/jmcp.cjs`: `node cli/jmcp.cjs list | catalog | install <server> [agents..] | update [server] | probe <agent> <server>`.
- `test/*.test.cjs`: `node:test` suites.

## How the servers are built

- Plain Node, no MCP SDK. JSON-RPC 2.0 over stdin/stdout, one message per line, through `servers/<id>/lib/rpc.js`. Every server has its own copy because each is installed on its own; keep the seven copies identical (`test/rpc.test.cjs` checks this). Change one, then copy it to the others.
- A server is a `methods` object passed to `serve(methods, onEnd)`. In `tools/call`: an unknown tool throws `rpcError(-32602, ...)`; arguments are checked with `checkArgs(tool.inputSchema, args)` before the tool runs; tool failures go back as `isError: true` results.
- Data lives in SQLite under `~/.jmcp/*.db` (`node:sqlite`, WAL, busy_timeout). `JMCP_HOME` overrides the folder; tests always use a scratch home. Never use localStorage or JSON files as the source of truth.
- A check-then-write (an upsert, a replace by name) runs inside one `BEGIN IMMEDIATE` transaction, because the app and several agents use the same database at once.
- Agents look things up by name (`{ byName: true }`); the app uses ids. Never fall back from one to the other on agent paths.
- Instruction files and anything an agent can overwrite keep a copy in a trash the app can restore. Memories refuse secrets.

## Changing a server

1. Edit `servers/<id>/`, add or update tests, run them.
2. Bump `servers/<id>/package.json` `version` (and `package-lock.json` if the server has one). Installed copies in `~/.jmcp/servers/<id>` only update when the repo version is newer.
3. Update the installed copies: `node cli/jmcp.cjs update` (the app also does this when it starts).
4. Agents keep running the old server process until their session restarts. Verify the change in a fresh session or a new subagent, with the real installed server, not only the tests.
5. Update the server's `README.md` and the root `README.md` when tools change.

## Tests

- One file: `node --test --test-concurrency=1 test/<name>.test.cjs`
- Everything: `npm test` (several minutes; run it in the background).
- Tests must not open windows, start Electron, SSH to real hosts or start real agents. Real-world checks are separate and described in the report.

## Windows rules

- Every child process starts hidden (`windowsHide: true`). No visible console or app windows on the user's desktop. UI checks happen in a VirtualBox VM, not on the host.
- Kill child processes with `killTree` from `servers/subagents/lib/win-command.js` (taskkill /T on Windows, the process group on POSIX), not `child.kill()`, so nothing they started is left running.
- Paths passed to `ssh -F` use forward slashes; ProxyJump drops backslashes.
- The working copy has CRLF line endings (`core.autocrlf=true`). Normalize a file with `sed -i 's/\r$//'` before scripted string edits, or use the Edit tool.

## Reviews

- Code reviews go to subagents through jmcp-subagents. The user's default provider is claude; use droid (model `gpt-6.1-sol`) or another provider only when the user asks for it.
- Give each reviewer one area, read-only, and ask for concrete failures with file:line. Fix, add a test for each fix, then send the same reviewer another round until it reports none.

## Verifying for real

- A feature is done only when it worked against the real thing: the installed MCP server called from a real agent (use jmcp-subagents to start one), real files, real SSH hosts when the user asked for that. Fakes are only for unit tests.
- Say plainly what was not verified.

## Writing

- Plain, short sentences in UI text, docs and replies. No em-dashes, no marketing words.
- Commit messages say what changed for the user. The repo is public at https://github.com/Josephivgi/JMCP.

## Releases

- The app updates itself from GitHub Releases (`app/updater.cjs`, electron-updater). Release with `npm version patch && git push --follow-tags`; `.github/workflows/release.yml` builds the Windows installer and uploads it to a draft release. Write the user-facing notes, show them to the user, then publish the draft (`gh release edit <tag> --notes-file <file> --draft=false`). Installed apps only see published releases.
- The packaged app has `asar: false` so `servers/` stays plain files that `core/catalog.cjs` can copy to `~/.jmcp/servers`. Keep it that way.
