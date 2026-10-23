# jmcp-subagents

The first official JMCP server. It lets any coding agent start subagents from
other providers. Claude Code can hand a task to Factory Droid, Codex can ask
Devin, OpenCode can run Grok, and so on.

## Tools

| Tool | What it does |
| --- | --- |
| `providers` | Agents you can start and whether each is installed |
| `spawn` | Start a subagent on a task; waits for its reply by default |
| `workflow` | Run several subagents: parallel steps, and steps that wait on others (`after`), with `{{id}}` to pass a reply on |
| `workflow_status` | Steps, status and replies of a workflow |
| `list` | Your subagents and their latest replies |
| `wait` | Wait for a subagent to finish its turn |
| `send` | Send a follow-up message |
| `read` | Read a subagent's transcript |
| `stop` | Stop a turn, close a session, or remove a subagent |

Providers: Claude Code (`claude`), Codex (`codex`), Factory Droid (`droid`),
Devin, Cursor, OpenCode, Gemini CLI, Qwen Code, Grok, GitHub Copilot CLI,
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

## Install

Use the JMCP app (JMCP servers > Subagents > Install), or from a terminal:

```
node cli/jmcp.cjs install subagents            # every agent found
node cli/jmcp.cjs install subagents claude-code codex
```
