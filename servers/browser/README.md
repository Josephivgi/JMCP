# jmcp-browser

A headless browser for coding agents. Each browser is Chrome or Edge started
hidden (`--headless=new`) on a fresh profile with no saved logins, driven over
the DevTools protocol on 127.0.0.1. No packages: Node's own WebSocket and
fetch do the work.

The open browsers are listed in `~/.jmcp/browser.db`. The JMCP app's
**Browsers** page reads it and shows each one with a live view of its page,
which agent opened it, the folder it works in and its last action. You can
close a browser from there; the agent is told on its next call.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_open` | Start a browser, optionally at a URL. Up to 4 per agent session |
| `browser_navigate` | Go to a URL and wait for it to load |
| `browser_snapshot` | Title, URL, a numbered list of links, buttons and fields, and the page text |
| `browser_click` | Click by `ref` (from the snapshot), CSS `selector` or visible `text` |
| `browser_type` | Click a field and type, replacing its text unless `append`; `submit` presses Enter |
| `browser_press` | Press Enter, Tab, Escape, arrows and other keys |
| `browser_back` | Go back one page |
| `browser_screenshot` | PNG of the page (`full_page` for all of it) |
| `browser_eval` | Run JavaScript in the page and get the result as JSON |
| `browser_list` | The browsers this session has open |
| `browser_close` | Close a browser and delete its profile |

Every tool but `browser_open` and `browser_list` takes `browser` (for example
`browser-1`) and defaults to the one used last.

## Lifetime

- A browser closes when the agent calls `browser_close`, when you close it on
  the Browsers page, or when the agent's session ends (the server's stdin
  closes).
- If a server is killed before it can clean up, the next jmcp-browser server
  or the Browsers page closes what it left. A browser is only closed after its
  DevTools port proves it is the browser that row started.
- Typed text is never written to the database, only how many characters were
  typed, since it may be a password.

## Settings

- `JMCP_BROWSER`: the browser program to use. Otherwise Chrome, then Edge,
  then Chromium. A browser that will not start hands over to the next one.
- `JMCP_HOME`: a different JMCP data folder.
