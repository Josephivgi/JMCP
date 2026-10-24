# jmcp-instructions

MCP server for agent instruction files: `AGENTS.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `GEMINI.md` and `QWEN.md`. Install it into an agent with
JMCP and the agent can manage those files when you ask it to.

Tools:

- `list`: each agent's global file (for example `~/.codex/AGENTS.md` and
  `~/.claude/CLAUDE.md`), made or not, and every project folder saved in JMCP.
  Pass `folder` to also look in another folder.
- `read`: a file's text and a hash.
- `write`: create or replace a file. Pass the hash from `read` and the write is
  refused if the file changed since.
- `delete`: remove a file.

Only files with those names can be touched. Every delete and overwrite first
copies the old file to `~/.jmcp/instructions-trash` (the newest 300 are kept),
and the Instructions page in the JMCP app can restore it. Project folders and
the trash list live in `~/.jmcp/instructions.db`. `JMCP_HOME` can point the
server at a different JMCP data folder.
