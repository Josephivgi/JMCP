"use strict";

// Turns collected facts into a list of problems. Each problem says what was
// measured, why it matters, and what to do. `affects` tags which questions it
// answers: "text" (text slow to appear in the browser) and "glitch" (stutter,
// freezes, crashes).

const RANK = { high: 0, medium: 1, low: 2, info: 3 };

function analyze(f) {
  const out = [];
  const add = (severity, area, affects, title, evidence, why, fix) => out.push({ severity, area, affects, title, evidence, why, fix });
  const sys = f.system || {};
  const cpu = f.cpu || {};
  const mem = f.memory || {};
  const net = f.network || {};
  const ev = f.events || {};
  const win = f.os === "windows";
  const procs = f.procs || [];
  const topCpu = procs.filter((p) => p.cpuPct >= 5).sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 4);
  const topMem = procs.slice().sort((a, b) => b.memMB - a.memMB).slice(0, 4);
  const list = (ps, key, unit) => ps.map((p) => p.name + (p.count > 1 ? " x" + p.count : "") + " " + p[key] + unit).join(", ");

  // CPU
  if (cpu.loadPct != null && cpu.loadPct >= 85)
    add("high", "cpu", ["text", "glitch"], "CPU is maxed out (" + cpu.loadPct + "%)", "Busiest: " + (list(topCpu, "cpuPct", "%") || "spread across many processes"),
      "When every core is busy, the browser waits its turn to lay out and paint text, and the mouse, audio and video stutter.",
      "Close or restart the busiest process above. If it is a browser tab, find it in the browser's task manager (Shift+Esc in Chrome/Edge).");
  else if (cpu.loadPct != null && cpu.loadPct >= 60)
    add("medium", "cpu", ["text", "glitch"], "CPU is busy (" + cpu.loadPct + "%)", "Busiest: " + (list(topCpu, "cpuPct", "%") || "spread out"),
      "Heavy background work leaves less headroom for the browser and the UI, so short spikes show up as lag.", "Check the processes above; pause sync, indexing, updates or builds while you work.");
  if (cpu.queue != null && cpu.cores && cpu.queue > cpu.cores * 2)
    add("medium", "cpu", ["glitch"], "Threads are queued waiting for CPU (" + cpu.queue + ")", "Queue length " + cpu.queue + " on " + cpu.cores + " logical cores",
      "A long run queue means programs are ready but waiting, which feels like hitches even when the average load looks fine.", "Find what spawns many busy threads (builds, VMs, antivirus scans).");
  if (cpu.load5 != null && cpu.cores && cpu.load5 > cpu.cores * 1.5)
    add("high", "cpu", ["text", "glitch"], "Load average is " + cpu.load5 + " on " + cpu.cores + " cores", "load 1/5/15: " + [cpu.load1, cpu.load5, cpu.load15].join(" / "),
      "More runnable work than cores: requests wait before they are served, so pages take longer to start sending text.", "Find the heavy processes; add cores or spread the work.");
  if (cpu.dpcPct != null && cpu.dpcPct + (cpu.interruptPct || 0) >= 5)
    add("high", "drivers", ["glitch"], "Drivers are eating CPU time (DPC " + cpu.dpcPct + "%, interrupts " + (cpu.interruptPct || 0) + "%)", "Measured over the sample",
      "High DPC/interrupt time comes from a misbehaving driver (often Wi-Fi, audio, GPU or USB). It causes audio crackle, mouse jumps and frame drops that look random.",
      "Update or roll back the network, audio and GPU drivers. LatencyMon shows which driver it is.");
  if (cpu.maxMHz && cpu.currentMHz && cpu.currentMHz < cpu.maxMHz * 0.5 && (cpu.loadPct || 0) > 30)
    add("medium", "power", ["text", "glitch"], "CPU is running at " + cpu.currentMHz + " of " + cpu.maxMHz + " MHz while busy", "Clock speed under half of its rated speed under load",
      "A throttled CPU (heat, battery saver or a power limit) makes everything slower, including drawing text.", "Plug in, switch to a Balanced or High performance plan, and check fans and temperatures.");
  if (cpu.iowaitPct != null && cpu.iowaitPct >= 15)
    add("high", "disk", ["text", "glitch"], "CPU is waiting on disk " + cpu.iowaitPct + "% of the time", "iowait " + cpu.iowaitPct + "%",
      "Programs are stalled on storage reads/writes, so responses and page loads hang.", "Find the process doing heavy I/O (iotop) and check the disk's health.");
  if (cpu.stealPct != null && cpu.stealPct >= 10)
    add("high", "cpu", ["text", "glitch"], "VM is losing " + cpu.stealPct + "% CPU to its host (steal time)", "steal " + cpu.stealPct + "%",
      "The hypervisor gives this VM's CPU time to other guests, so it runs slower than its load suggests.", "Lower load on the host, or move to a plan with dedicated cores.");

  // Memory
  const usedPct = sys.totalMB ? Math.round(100 * (1 - sys.freeMB / sys.totalMB)) : null;
  if (usedPct != null && usedPct >= 90)
    add("high", "memory", ["text", "glitch"], "Memory is almost full (" + usedPct + "% used, " + sys.freeMB + " MB free)", "Largest: " + list(topMem, "memMB", " MB"),
      "When RAM runs out the system swaps to disk. Switching tabs or apps then stalls while data is read back, and tabs may reload or blank out.",
      "Close the largest apps above, cut down open tabs, or add RAM.");
  else if (usedPct != null && usedPct >= 80)
    add("medium", "memory", ["text", "glitch"], "Memory is getting tight (" + usedPct + "% used)", "Largest: " + list(topMem, "memMB", " MB"),
      "Little free RAM means the browser discards background tabs and the OS starts paging.", "Close apps you are not using.");
  if (mem.commitPct != null && mem.commitPct >= 90)
    add("high", "memory", ["glitch"], "Committed memory is at " + mem.commitPct + "% of the limit", "Page file " + mem.pagefileMB + " MB, " + mem.pagefileUsedMB + " MB used",
      "Near the commit limit, new allocations fail: apps crash or Windows warns about low memory.", "Close apps, or let Windows manage the page file size.");
  if (mem.pagesInPerSec != null && mem.pagesInPerSec >= 200)
    add("medium", "memory", ["text", "glitch"], "Heavy paging from disk (" + mem.pagesInPerSec + " page reads/s)", "Page reads per second during the sample",
      "Data is being pulled back from the page file, which is far slower than RAM. That is the classic 'everything freezes for a second' feeling.", "Free up RAM.");
  if (mem.swapMB && mem.swapUsedMB / mem.swapMB >= 0.5)
    add("medium", "memory", ["text", "glitch"], "Swap is " + Math.round((100 * mem.swapUsedMB) / mem.swapMB) + "% used", mem.swapUsedMB + " of " + mem.swapMB + " MB",
      "Heavy swap use means memory pages live on disk and every touch of them is slow.", "Find the memory-heavy process; add RAM or limit it.");
  const pr = f.pressure || {};
  if (pr.memory >= 10) add("high", "memory", ["text", "glitch"], "Memory pressure stalls (" + pr.memory + "% of time)", "PSI memory some avg10=" + pr.memory, "Tasks were stalled waiting for memory.", "Reduce memory use or add RAM.");
  if (pr.io >= 20) add("medium", "disk", ["text", "glitch"], "I/O pressure stalls (" + pr.io + "% of time)", "PSI io some avg10=" + pr.io, "Tasks were stalled waiting for disk.", "Find the heavy I/O process.");
  if (pr.cpu >= 30) add("medium", "cpu", ["text", "glitch"], "CPU pressure stalls (" + pr.cpu + "% of time)", "PSI cpu some avg10=" + pr.cpu, "Runnable tasks waited for CPU.", "Reduce CPU load.");
  if (ev.oomKills > 0)
    add("high", "memory", ["glitch"], "Out-of-memory killer fired " + ev.oomKills + " time(s) in 7 days", "Kernel log", "The kernel killed processes to free RAM; services restart or vanish.", "Find the memory-hungry process; add RAM or memory limits.");

  // Disk
  for (const d of f.disks || []) {
    if (!d.totalGB) continue;
    const pct = Math.round(100 * (d.freeGB / d.totalGB));
    // Small partitions (/boot, EFI) are judged by percentage only.
    if (pct <= 5 || (d.freeGB < 3 && pct <= 15 && d.totalGB >= 20))
      add("high", "disk", ["text", "glitch"], d.mount + " is nearly full (" + d.freeGB + " GB free)", d.freeGB + " of " + d.totalGB + " GB free",
        "With no free space, the page file, browser cache and temp files cannot grow. Apps hang, updates fail and the browser cannot cache pages.", "Free space: empty Downloads and Recycle Bin, run Disk Cleanup, move large files.");
    else if (pct <= 12)
      add("medium", "disk", ["glitch"], d.mount + " is low on space (" + pct + "% free)", d.freeGB + " of " + d.totalGB + " GB free",
        "SSDs slow down when nearly full, and Windows needs room for updates and the page file.", "Free up some space.");
    if (d.inodesUsedPct >= 90)
      add("high", "disk", ["glitch"], d.mount + " is out of inodes (" + d.inodesUsedPct + "%)", "df -i", "No new files can be made even with free space left.", "Delete piles of small files (caches, sessions, logs).");
  }
  const io = f.diskIO || {};
  if (io.busyPct >= 90 || io.avgSecPerTransfer >= 0.05)
    add("high", "disk", ["text", "glitch"], "Disk is saturated (" + io.busyPct + "% busy, " + Math.round((io.avgSecPerTransfer || 0) * 1000) + " ms per request)", "Queue " + io.queue,
      "Each disk request takes long enough to notice. Opening apps, loading cached pages and saving files all wait on it.", "Find the process hammering the disk in Resource Monitor > Disk; on an HDD, an SSD is the fix.");
  for (const d of f.physicalDisks || []) {
    if (d.health && !/^healthy$/i.test(String(d.health).trim()))
      add("high", "disk", ["glitch"], "Disk " + d.name + " reports " + d.health, d.media + " " + d.bus, "A failing drive causes freezes, corrupt files and crashes, and can lose data.", "Back up now, then replace the drive.");
    if (/HDD/i.test(d.media) && (f.disks || []).length)
      add("medium", "disk", ["text", "glitch"], d.name + " is a spinning hard drive", d.sizeGB + " GB " + d.media,
        "Hard drives are about 100x slower than SSDs at random reads. If Windows or the browser profile lives on it, everything feels sluggish.", "Move Windows and the browser profile to an SSD.");
  }
  if (ev.diskErrors > 0 || ev.ntfsErrors > 0)
    add("high", "disk", ["glitch"], "Disk errors in the event log (" + (ev.diskErrors || 0) + " disk, " + (ev.ntfsErrors || 0) + " NTFS)", "Last 7 days",
      "Bad blocks or a loose cable make reads retry, which freezes whatever is waiting for them.", "Back up, run chkdsk /scan, check the drive's SMART data and cable.");
  if (ev.ioErrors > 0)
    add("high", "disk", ["glitch"], "Storage or hardware errors in the kernel log (" + ev.ioErrors + ")", "Last 7 days", "I/O errors, NVMe resets or machine-check events point at failing hardware.", "Check smartctl, dmesg, and back up.");
  if ((f.dstate || []).length >= 3)
    add("medium", "disk", ["glitch"], (f.dstate || []).length + " processes stuck waiting on I/O", f.dstate.join(", "), "Processes in D state are blocked on disk or network storage.", "Check the storage or NFS mounts they use.");

  // Crashes and hardware
  if (ev.unexpectedShutdowns > 0)
    add("high", "stability", ["glitch"], "Unexpected shutdowns or resets: " + ev.unexpectedShutdowns + " in 7 days", "Kernel-Power 41",
      "The computer lost power or reset without shutting down: overheating, a weak power supply, unstable overclock or a driver crash.", "Check temperatures, remove any overclock/XMP to test, update BIOS and drivers.");
  if (ev.bugchecks > 0)
    add("high", "stability", ["glitch"], "Blue screens: " + ev.bugchecks + " in 7 days", "BugCheck reports", "A driver or hardware fault crashed Windows.", "Look up the stop code in Reliability Monitor; update the named driver; test RAM.");
  if (ev.whea > 0)
    add("high", "hardware", ["glitch"], "Hardware errors reported by the CPU/PCIe: " + ev.whea + " in 7 days", "WHEA-Logger",
      "WHEA errors come from the CPU, RAM or PCIe devices. They cause random freezes and crashes, and usually point at overclocking, heat or failing hardware.", "Undo overclocks and XMP, update BIOS and chipset drivers, run a memory test.");
  if (ev.gpuResets > 0)
    add("high", "gpu", ["text", "glitch"], "Graphics driver stopped responding " + ev.gpuResets + " time(s) in 7 days", "Display 4101",
      "The screen flickers or goes black and apps redraw slowly while the driver recovers. Browsers draw text on the GPU, so they hitch too.", "Install the latest driver from the GPU maker (clean install); check GPU temperature.");
  if (ev.resourceExhaustion > 0)
    add("high", "memory", ["glitch"], "Windows ran low on virtual memory " + ev.resourceExhaustion + " time(s)", "Resource-Exhaustion-Detector 2004", "Some app leaked memory until Windows had to warn.", "Find the app that grows over time in Task Manager.");
  if (ev.driverFailures > 0)
    add("low", "stability", ["glitch"], "Services or drivers failed to start/crashed " + ev.driverFailures + " time(s)", "Service Control Manager", "Failing services can retry in loops and waste CPU.", "Check Event Viewer > System for the service names.");
  const crashes = (ev.appCrashes || []).filter((c) => c.count >= 2);
  if (crashes.length)
    add("medium", "stability", ["glitch"], "Apps crashing repeatedly", crashes.map((c) => c.app + " x" + c.count).join(", "), "Repeated crashes of the same app point at a bad update, plugin or driver.", "Update or reinstall those apps.");
  const hangs = (ev.appHangs || []).filter((c) => c.count >= 2);
  if (hangs.length)
    add("medium", "stability", ["text", "glitch"], "Apps freezing (Not Responding)", hangs.map((c) => c.app + " x" + c.count).join(", "), "Windows logged these apps as hung.", "Update them; check their add-ons.");
  for (const e of (ev.failedUnits || []).slice(0, 1))
    add("medium", "services", ["glitch"], "Failed systemd units: " + ev.failedUnits.join(", "), "systemctl --failed", "Services that crashed or failed to start.", "journalctl -u " + e + " to see why.");
  if (f.zombies >= 20) add("low", "services", ["glitch"], f.zombies + " zombie processes", "ps", "A parent process is not reaping its children.", "Restart the parent service.");

  const hot = (f.thermal || []).filter((t) => t >= 85 && t < 150);
  if (hot.length)
    add("high", "heat", ["text", "glitch"], "Running hot (" + Math.max(...hot) + " C)", "Thermal zones: " + f.thermal.join(", "),
      "Hot chips slow themselves down to cool off, which shows up as sudden lag spikes.", "Clean dust from fans and vents, keep a laptop on a hard surface, check fan curves.");

  // Power and updates
  const pw = f.power || {};
  if (pw.plan && /saver|power saver/i.test(pw.plan))
    add("medium", "power", ["text", "glitch"], "Power plan is " + pw.plan, "powercfg", "Power saver caps CPU speed and makes the system feel slow.", "Switch to Balanced in Settings > System > Power.");
  if (pw.onBattery)
    add(pw.batteryPct != null && pw.batteryPct <= 20 ? "medium" : "low", "power", ["text", "glitch"], "Running on battery (" + pw.batteryPct + "%)", "Win32_Battery",
      "On battery, laptops lower CPU and GPU clocks, and below 20% battery saver may turn on.", "Plug in when you need full speed.");
  if (f.pendingReboot)
    add("low", "updates", ["glitch"], "A restart is pending for updates", "Reboot-required flag", "Half-installed updates can leave drivers and services in a mixed state.", "Restart when you can.");
  if (sys.uptimeSec >= 14 * 86400 && win)
    add("low", "updates", ["glitch"], "Not restarted for " + Math.round(sys.uptimeSec / 86400) + " days", "Uptime",
      "Memory leaks in drivers and apps build up over weeks. Fast Startup means shutdown does not reset this; only Restart does.", "Restart.");
  if (f.startupCount >= 25)
    add("low", "startup", ["glitch"], f.startupCount + " programs start with Windows", "Win32_StartupCommand", "Many background apps compete for CPU, RAM and disk.", "Turn off the ones you do not need in Task Manager > Startup apps.");

  // GPU and display
  for (const g of f.gpu || []) {
    if (/Basic Display|Basic Render/i.test(g.name))
      add("high", "gpu", ["text", "glitch"], "No real graphics driver installed (" + g.name + ")", "Win32_VideoController", "Without a GPU driver, scrolling and text drawing are done slowly on the CPU.", "Install the GPU driver.");
    if (g.driverDate && Date.now() - Date.parse(g.driverDate) > 2 * 365 * 86400000)
      add("low", "gpu", ["glitch"], g.name + " driver is from " + g.driverDate, "Driver " + g.driver, "Old GPU drivers miss fixes for browsers and newer Windows builds.", "Update from the GPU maker's site.");
  }

  // Network (the main reason text is slow to appear, before rendering starts)
  if (net.dnsMs != null && net.dnsMs >= 150)
    add(net.dnsMs >= 500 ? "high" : "medium", "network", ["text"], "DNS lookups are slow (" + net.dnsMs + " ms)", "Lookup of www.google.com" + (net.dnsMissMs != null ? "; uncached name " + net.dnsMissMs + " ms" : ""),
      "Every new site name must be resolved before the browser can even ask for the page, so text appears late on first visits.", "Use a faster DNS server (1.1.1.1 or 8.8.8.8), or check the router.");
  if (net.lossPct != null && net.lossPct > 0)
    add(net.lossPct >= 25 ? "high" : "medium", "network", ["text", "glitch"], "Packet loss (" + net.lossPct + "%)", "Ping to 1.1.1.1",
      "Lost packets must be resent, adding 200 ms to seconds per loss. Pages stall partway, video calls and games glitch.", "Move closer to the router or use Ethernet; restart the router; check cables.");
  if (net.pingMs != null && net.pingMs >= 80)
    add("medium", "network", ["text"], "High latency (" + net.pingMs + " ms average, max " + net.pingMaxMs + ")", "Ping to 1.1.1.1",
      "Each round trip (DNS, TCP, TLS, request) costs this much, and a page needs several before the first text shows.", "Check for downloads hogging the connection, Wi-Fi signal, or VPN routing.");
  else if (net.pingMaxMs != null && net.pingMs != null && net.pingMaxMs > net.pingMs * 3 && net.pingMaxMs > 60)
    add("low", "network", ["text", "glitch"], "Latency spikes (avg " + net.pingMs + " ms, max " + net.pingMaxMs + ")", "Ping to 1.1.1.1", "Jitter makes some loads instant and others hang.", "Usually Wi-Fi interference or a busy connection.");
  if (net.wifiSignalPct != null && net.wifiSignalPct < 60)
    add("medium", "network", ["text", "glitch"], "Weak Wi-Fi signal (" + net.wifiSignalPct + "%)", "netsh wlan", "Weak signal means retries and slow rates.", "Move closer, use 5 GHz, or use Ethernet.");
  if (net.proxy || net.pac)
    add("low", "network", ["text"], "A proxy is set" + (net.proxyServer ? " (" + net.proxyServer + ")" : "") + (net.pac ? " (PAC " + net.pac + ")" : ""), "Internet Settings",
      "Every request goes through the proxy first, which adds delay and can stall if it is slow.", "Turn it off in Settings > Network > Proxy if you do not need it.");
  if ((net.vpn || []).length)
    add("info", "network", ["text"], "VPN/tunnel adapter active: " + net.vpn.join(", "), "Network adapters", "Traffic takes a longer path, adding latency to each request.", "Disconnect the VPN to compare.");

  // Browser
  for (const b of f.browsers || []) {
    if (b.hardwareAcceleration === false)
      add("high", "browser", ["text", "glitch"], b.name + " has hardware acceleration turned off", "Local State", "Without GPU acceleration, text and scrolling are drawn on the CPU and lag on busy pages.", b.name + " Settings > System > turn on 'Use graphics acceleration when available', then relaunch.");
    if (b.extensions >= 15)
      add("medium", "browser", ["text"], b.name + " has " + b.extensions + " extensions installed", b.profiles + " profile(s)",
        "Extensions inject scripts into every page and run before the page shows; ad blockers and grammar tools are common culprits.", "Remove ones you do not use; test in a guest window to compare.");
    if (b.memMB >= 4000 && sys.totalMB && b.memMB / sys.totalMB >= 0.3)
      add("medium", "browser", ["text", "glitch"], b.name + " is using " + Math.round(b.memMB / 1024 * 10) / 10 + " GB across " + b.processes + " processes", "Working set",
        "Many tabs keep memory busy; the browser and OS compete for RAM.", "Close or suspend tabs (Memory Saver in Chrome/Edge).");
  }
  if (f.fonts >= 1500)
    add("low", "fonts", ["text"], f.fonts + " fonts installed", "Fonts folders", "Huge font collections slow font fallback lookups and the first draw of text in apps and browsers.", "Remove font packs you do not use.");

  // Docker on servers
  const restarting = (f.docker || []).filter((c) => /restarting|unhealthy|exited/i.test(c.status));
  if (restarting.length)
    add("high", "services", ["text", "glitch"], "Containers unhealthy or restarting", restarting.map((c) => c.name + " (" + c.status + ")").join(", "), "A crashing container makes its site slow or down while it restarts.", "docker logs <name>.");

  // Top kernel/journal errors are listed as info so nothing found is hidden.
  const errs = (ev.topErrors || []).filter((e) => e.count >= 5).slice(0, 3);
  if (errs.length) add("info", "logs", ["glitch"], "Frequent errors in the system log since boot", errs.map((e) => e.count + "x " + e.text).join(" | "), "Repeated errors can mean a looping service.", "journalctl -p 3 -b");

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// General reasons that are always true for slow text, so the answer still
// explains the causes when the computer itself looks fine.
const TEXT_REASONS = [
  "Web fonts: many sites hide text until their custom font downloads (FOIT). Without font-display: swap the text stays invisible for up to 3 seconds on a slow connection.",
  "Render-blocking CSS and scripts in <head>: the browser will not paint anything until they download and run.",
  "Slow server response (time to first byte): the server builds the page before sending any of it.",
  "New-connection cost: DNS lookup, TCP handshake and TLS handshake each take a round trip before the first byte.",
  "Pages built by JavaScript (React/Vue apps without server rendering) show text only after the bundle downloads, parses and runs.",
  "Extensions run scripts on every page before it is shown.",
  "A busy computer (CPU, RAM, disk) or disabled GPU acceleration slows layout and painting.",
];

const GLITCH_REASONS = [
  "Running out of RAM, so the system swaps to disk.",
  "A process using all CPU or disk in the background (updates, antivirus scans, indexing, sync).",
  "Graphics driver crashes or old drivers.",
  "Overheating that throttles the CPU/GPU.",
  "Failing or full storage.",
  "Driver latency (Wi-Fi, audio, USB) causing stutter.",
  "Unstable overclock/XMP or failing hardware (WHEA errors, unexpected resets).",
];

function summary(f) {
  const s = f.system || {};
  const c = f.cpu || {};
  const used = s.totalMB ? Math.round(100 * (1 - s.freeMB / s.totalMB)) : null;
  return {
    target: f.target,
    host: s.hostname,
    os: s.caption,
    uptimeDays: s.uptimeSec != null ? Math.round((s.uptimeSec / 86400) * 10) / 10 : null,
    cpu: c.model ? c.model + " (" + c.cores + " threads)" : undefined,
    cpuLoadPct: c.loadPct,
    memory: s.totalMB ? used + "% of " + Math.round(s.totalMB / 1024) + " GB used" : undefined,
    disks: (f.disks || []).map((d) => d.mount + " " + d.freeGB + "/" + d.totalGB + " GB free"),
    network: f.network ? { dnsMs: f.network.dnsMs, pingMs: f.network.pingMs, lossPct: f.network.lossPct } : undefined,
    collectSeconds: f.collectMs ? Math.round(f.collectMs / 100) / 10 : undefined,
  };
}

module.exports = { analyze, summary, TEXT_REASONS, GLITCH_REASONS };
