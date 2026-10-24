# jmcp-memory

MCP server for memory shared by every coding agent. Install it with JMCP and
each agent reads and writes the same `~/.jmcp/memory.db`, so a preference
Claude Code saves is there when Codex or Droid starts.

Tools: `memory_search`, `memory_read`, `memory_save`, `memory_delete`. The
server's start-up instructions list every saved memory by name and title.
Each memory records which agent saved it last. `memory_save` refuses text
that looks like a secret (API keys, tokens, private keys, passwords), since
every agent reads these memories.

Manage memories on the Memory page of the JMCP app. `node cli/jmcp.cjs memory
list` prints them. `JMCP_HOME` points the server at a different data folder.
