# jmcp-subagents

The first official JMCP server. It lets any coding agent start subagents from
other providers. Claude Code can hand a task to Factory Droid, Codex can ask
Devin, OpenCode can run Grok, and so on.

## Tools

| Tool | What it does |
| --- | --- |
| `providers` | Agents you can start and whether each is installed |
| `spawn` | Start a subagent on a task; waits for its reply by default. With `wait: false` you can start several at once and `wait` on each |
| `list` | Your subagents and their latest replies |
| `wait` | Wait for a subagent to finish its turn |
| `send` | Send a follow-up message |
| `read` | Read a subagent's transcript |
| `stop` | Stop a turn, close a session, or remove a subagent |

Providers: Claude Code (`claude`), Codex (`codex`), Factory Droid (`droid`),
Devin, Cursor, OpenCode, Gemini CLI, Qwen Code, Grok,
Kilo, goose, Cline, Kimi. Each must be installed and signed in on its own.

## How it works

The agent that runs this server is the parent. Subagents run as hidden child
processes of the server, over ACP (Claude Code through the Claude Agent SDK).
A subagent cannot start subagents: each one runs with `JMCP_SUBAGENT` set, and
a server that starts with it set offers no tools. Records and transcripts are
kept in `~/.jmcp/subagents.db`; the JMCP app shows them under Activity.

## Settings (environment)

- `JMCP_PERMISSIONS`: how subagent tool calls are answered. `auto` (default)
  allows each once, `edits` allows reads and edits only, `full` allows always,
  `deny` denies everything that asks.
- `JMCP_MAX_SUBAGENTS`: running subagents per parent (default 6).
- `JMCP_HOME`: where the database lives (default `~/.jmcp`).

## Updates

The JMCP app keeps a copy of this server in `~/.jmcp/servers/subagents` and
points every agent at it. When JMCP has a newer version than that copy, the
app updates it when it starts (JMCP servers also shows an Update button),
and rewrites the entry in each agent that has it. Agents load the new
version the next time they start the server. From a terminal:

```
node cli/jmcp.cjs update
```

## Install

Use the JMCP app (JMCP servers > Subagents > Install), or from a terminal:

```
node cli/jmcp.cjs install subagents            # every agent found
node cli/jmcp.cjs install subagents claude-code codex
```
