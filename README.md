# JMCP

JMCP shows the MCP servers of every coding agent on your computer in one
place and installs JMCP servers into all of them at once.

Agents: Claude Code, Codex, Factory Droid, OpenCode, Devin, Cursor, Gemini
CLI, Qwen Code and Grok.

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

## jmcp-rules

Set DO and DON'T rules in the JMCP app and install jmcp-rules into your agents
to share them. Agents can read the latest rules with the `rules`
tool, but only the app can edit them. See [servers/rules](servers/rules/README.md).
Use `node cli/jmcp.cjs rules list` to view them in a terminal.

## jmcp-instructions

Manage instruction files instead of rules: `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md` and `QWEN.md`. The Instructions page lists each agent's global
file and any project folders you add, with an editor to create, edit and
delete them. Deleted and overwritten files are kept so you can restore them.
Installed agents get `list`, `read`, `write` and `delete` tools for the same
files. See [servers/instructions](servers/instructions/README.md).

## jmcp-memory

Memory shared by every agent. What one agent saves (a preference, a decision,
a project fact), the others can search and read. The Memory page lists,
searches, adds, edits and deletes memories and shows which agent saved each
one. Agents cannot save secrets there. See
[servers/memory](servers/memory/README.md).

## jmcp-skills

One skills library for every agent, including agents with no skills feature.
The Skills page adds, edits, turns off and deletes skills, and imports
`SKILL.md` folders from Claude Code, Codex, Droid, Cursor, Gemini, OpenCode,
Grok and `.agents`. Agents can also save a skill with `skill_save`, for
example a procedure they worked out, for every agent to use next time. See
[servers/skills](servers/skills/README.md).

## jmcp-health

Checks this computer and the hosts in `~/.ssh/config`, and explains what is
wrong in plain words. The Health page shows CPU, memory, disks and problems,
and installs package updates on SSH hosts. Agents get the same checks, an
`updates` tool to check and install updates on a host when you ask, and
`show_user` to leave you a card on the Health page. See
[servers/health](servers/health/README.md).

## Run

```
npm install
npm start                 # the app
node cli/jmcp.cjs list    # every agent and its servers
npm test                  # unit tests (scratch folders only)
node test/live/spawn.cjs droid      # a real subagent
```

`--home <folder>` (app and CLI) works on a scratch home instead of yours.
