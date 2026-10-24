# jmcp-instructions

MCP server for agent instruction files: `AGENTS.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `GEMINI.md` and `QWEN.md`. Install it into an agent with
JMCP and the agent can manage those files when you ask it to.

Tools:

- `list`: each agent's global file (for example `~/.codex/AGENTS.md` and
  `~/.claude/CLAUDE.md`), made or not, Claude Code's rule files in
  `~/.claude/rules`, every project folder saved in JMCP, and project folders
  found on this computer. Pass `folder` to also look in another folder.
- `read`: a file's text and a hash.
- `write`: create or replace a file. To replace a file that exists, pass the
  hash from `read`; the write is refused without it, or if the file changed
  since.
- `delete`: remove a file.

Only files with those names, and `.md` files directly in `~/.claude/rules`,
can be touched. Every delete and overwrite first
copies the old file to `~/.jmcp/instructions-trash` (the newest 300 are kept),
and the Instructions page in the JMCP app can restore it. Project folders and
the trash list live in `~/.jmcp/instructions.db`. `JMCP_HOME` can point the
server at a different JMCP data folder.
