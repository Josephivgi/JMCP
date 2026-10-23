# JMCP

JMCP shows the MCP servers of every coding agent on your computer in one
place and installs JMCP servers into all of them at once.

Agents: Claude Code, Codex, Factory Droid, OpenCode, Devin, Cursor, Gemini
CLI, Qwen Code, Grok, GitHub Copilot CLI, Windsurf and VS Code.

## The app

- **JMCP servers**: JMCP's own servers. Pick agents and install or remove.
- **Agents**: one page per agent with the servers in its own config file,
  their command or URL, on or off, and a Check tools button that starts the
  server hidden and lists its tools.
- **Activity**: subagents run through jmcp-subagents.

When JMCP starts it updates any JMCP server it installed whose copy in
`~/.jmcp/servers` is older than the app's version. `node cli/jmcp.cjs update`
does the same from a terminal.

JMCP edits each agent's own config file in place. JSON files keep their
comments and formatting; TOML files only get that server's tables replaced.
The first time JMCP changes a file it saves a `.jmcp-backup` copy next to it.

## First server: jmcp-subagents

Cross-provider subagents, ported from the JAgents Subagents plugin so it runs
without the JAgents app. See [servers/subagents](servers/subagents/README.md).

## Run

```
npm install
npm start                 # the app
node cli/jmcp.cjs list    # every agent and its servers
npm test                  # unit tests (scratch folders only)
node test/live/spawn.cjs droid      # a real subagent
```

`--home <folder>` (app and CLI) works on a scratch home instead of yours.
