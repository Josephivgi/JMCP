# jmcp-browser

A headless browser for coding agents. Each browser is Chrome or Edge started
hidden (`--headless=new`) on a fresh profile with no saved logins, driven over
the DevTools protocol on 127.0.0.1. No packages: Node's own WebSocket and
fetch do the work.

The open browsers are listed in `~/.jmcp/browser.db`. The JMCP app's
**Browsers** page reads it and shows each one with a live view of its page,
which agent opened it, the folder it works in and its last action. You can
close a browser from there; the agent is told on its next call.

## Handing a browser to the user

When a person has to act (a CAPTCHA, a login, a 2FA code), the agent calls
`browser_handoff` with what you should do. The Browsers page highlights that
browser, the sidebar count turns blue and Windows shows a notice. **Take
control** turns its view into the live page: clicks, drags, typing, Ctrl+V and
scrolling on the picture go to the browser. **Hand back to agent** (with an
optional note) ends the wait and the agent carries on from the page you left.

You can also take control of any browser without being asked. Until you hand
it back, the agent can still read the page but its clicks, typing and
navigation are refused with a note to call `browser_handoff` and wait.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_open` | Start a browser, optionally at a URL. Up to 4 per agent session |
| `browser_navigate` | Go to a URL and wait for it to load |
| `browser_snapshot` | Title, URL, a numbered list of links, buttons and fields (`max_elements`, default 150), and the page text (`max_text`, default 8000). Same-site links show only their path |
| `browser_click` | Click by `ref` (from the snapshot), CSS `selector` or visible `text` |
| `browser_type` | Click a field and type, replacing its text unless `append`; `submit` presses Enter |
| `browser_press` | Press Enter, Tab, Escape, arrows and other keys |
| `browser_back` | Go back one page |
| `browser_screenshot` | PNG of the page (`full_page` for all of it) |
| `browser_eval` | Run JavaScript in the page and get the result as JSON |
| `browser_handoff` | Ask the user to take over (CAPTCHA, login) and wait until they hand it back. `timeout_sec` default 600, at most 900 |
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
