# jmcp-skills

MCP server for the skills you manage in the JMCP app. Install it with JMCP and
every agent gets the same skills from `~/.jmcp/skills.db`, including agents
that have no skills feature of their own.

Tools: `skills_list`, `skill_read` and `skill_save`. The server's start-up
instructions list each skill that is on (up to 60), with its description, so
the agent knows when to load it. A skill imported from a `SKILL.md` folder
also lists the files next to it.

`skill_save` adds a skill or replaces one by name, so an agent can write down a
procedure for the next session. It does not change skills imported from a
`SKILL.md` file; edit that file instead.

Add, edit, turn off and import skills on the Skills page of the JMCP app.
`node cli/jmcp.cjs skills list` prints them. `JMCP_HOME` points the server at a
different data folder.
