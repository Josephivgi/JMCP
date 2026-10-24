# jmcp-health

Checks this computer or an SSH host and explains what is wrong, in plain
words, worst first. Read-only, except `updates` with `install: true`, which
installs package updates on an SSH host when asked.

## Tools

| Tool | What it does |
| --- | --- |
| `targets` | This computer and the named hosts in `~/.ssh/config` |
| `problems` | Every problem found, with evidence, why it matters and a fix |
| `slow_text` | Why text might take a second to show in the browser. With `url`, also loads that page from the target and times DNS, connect, TLS, server wait and download, and checks the HTML and CSS for web fonts without `font-display: swap`, render-blocking CSS/JS and pages built by JavaScript |
| `glitchy` | Why the computer might stutter, freeze, flicker or crash |
| `updates` | Pending package updates on an SSH host (apt or dnf) and what would be installed. With `install: true`, installs them like the Health page does: keeps config files, removes nothing, never reboots |
| `show_user` | Leaves the user a card (title, details, level) on the Health page of the JMCP app |

Each tool except `updates` and `show_user` takes `target`: `local` (default), an alias from `~/.ssh/config`, or
`user@host`.

## What it checks

- **Windows:** CPU load, DPC/interrupt time, clock throttling, per-process CPU
  and RAM, commit and paging, disk space, disk busy time and health, 7 days of
  event log (unexpected shutdowns, blue screens, WHEA hardware errors, GPU
  driver resets, disk/NTFS errors, app crashes and hangs), power plan and
  battery, temperatures, pending restart, startup apps, DNS, ping and packet
  loss, Wi-Fi signal, proxy and VPN, Chrome/Edge/Brave/Firefox hardware
  acceleration, extensions and memory, installed font count.
- **Linux (over SSH):** CPU, iowait, steal time, load, memory and swap,
  pressure stall info, OOM kills, I/O and hardware errors in the kernel log,
  disk space and inodes, failed systemd units, stuck processes, temperatures,
  pending reboot, DNS and ping, Docker containers restarting or unhealthy.

SSH runs with `BatchMode=yes`, so it uses your keys and never prompts. All
child processes start hidden.
