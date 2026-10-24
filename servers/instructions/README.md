# jmcp-instructions

MCP server for agent instruction files: `AGENTS.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `GEMINI.md` and `QWEN.md`. Install it into an agent with
JMCP and the agent can manage those files when you ask it to.

Master instructions: one file, `~/.jmcp/master-instructions.md`, that you edit
on the Instructions page of the JMCP app. When an agent starts a session, the
server gives it this text in its instructions, labeled `MASTER INSTRUCTIONS`
with a line saying the agent must follow it in every task. Text over 32 KB is
cut there, with a note to call the tool for the rest. Agents can read it but
never change or delete it.

Some agents (Factory Droid) never show server instructions. So while master
instructions are set, each agent's global instruction file (the files `list`
shows, for agents whose folder exists) starts with one line telling the agent
to call `master_instructions` before its first reply. The line ends with an
`<!-- JMCP master instructions ... -->` marker. JMCP adds it when you save
master instructions, the app checks it at start, and the server puts it back
at every agent session start if it went missing. Deleting the master
instructions takes the line out again. Files are changed in place, so linked
files stay linked, and the old version goes to the trash first.

Tools:

- `master_instructions`: the current master instructions, in full, with the
  same label. Agents are told to call it at the start of every task, since
  some agents ignore server instructions and the text may have changed since
  the session started.
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
