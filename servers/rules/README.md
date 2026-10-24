# jmcp-rules

Read-only MCP server for the rules you set in the JMCP desktop app. Install it
into an agent with JMCP and it reads the shared `~/.jmcp/rules.db`. Each agent
gets the enabled rules when the server starts and can call the
`rules` tool at the start of every task to pick up changes without a restart.

Every rule applies to every agent. Edit rules in the JMCP app, not through
an agent or the CLI. `node cli/jmcp.cjs rules list` shows the
current rules. A rule can be up to 2000 characters; if all rules together pass
40000 characters, agents get the first ones and a note that the rest were cut. `--home <folder>` uses a scratch home; `JMCP_HOME` can point the
server at a different JMCP data folder.
