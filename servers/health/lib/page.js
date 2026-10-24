"use strict";

// Loads a page and times each step (DNS, connect, TLS, first byte, download),
// then reads the HTML for things that keep text from showing: web fonts
// without font-display, render-blocking CSS/JS, client-side rendering.

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { ssh } = require("./collect.js");

const MAX_BYTES = 4 * 1024 * 1024;

// Decompress at most MAX_BYTES. Resolves { body, cut, broken }: the first
// MAX_BYTES when there was more (cut), and whatever decoded before an error
// in a damaged body (broken).
function inflate(body, enc) {
  const make = enc === "gzip" ? zlib.createGunzip : enc === "br" ? zlib.createBrotliDecompress : enc === "deflate" ? zlib.createInflate : null;
  if (!make) return Promise.resolve({ body, cut: false, broken: false });
  return new Promise((resolve) => {
    const z = make();
    const out = [];
    let size = 0;
    let done = false;
    const finish = (cut, broken) => {
      if (done) return;
      done = true;
      z.destroy();
      resolve({ body: Buffer.concat(out).subarray(0, MAX_BYTES), cut, broken: Boolean(broken) });
    };
    z.on("data", (chunk) => {
      out.push(chunk);
      size += chunk.length;
      if (size > MAX_BYTES) finish(true);
    });
    z.on("end", () => finish(false));
    z.on("error", () => finish(false, true));
    z.end(body);
  });
}

// deadline is an absolute Date.now() time for the whole check, so a slow
// trickle or a chain of redirects cannot run past it.
function once(url, timeoutMs, deadline) {
  return new Promise((resolve, reject) => {
    const left = (deadline || Date.now() + timeoutMs) - Date.now();
    if (left <= 0) return reject(new Error("Timed out after " + timeoutMs / 1000 + "s"));
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const t = {};
    const req = mod.request(u, {
      method: "GET",
      agent: false,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 jmcp-health", accept: "text/html,*/*", "accept-encoding": "gzip, deflate, br" },
      timeout: timeoutMs,
    });
    req.on("socket", (s) => {
      s.on("lookup", () => (t.dns = ms()));
      s.on("connect", () => (t.connect = ms()));
      s.on("secureConnect", () => (t.tls = ms()));
    });
    req.on("timeout", () => req.destroy(new Error("Timed out after " + timeoutMs / 1000 + "s")));
    const hard = setTimeout(() => req.destroy(new Error("Timed out after " + timeoutMs / 1000 + "s")), left);
    req.on("close", () => clearTimeout(hard));
    req.on("error", reject);
    req.on("response", (res) => {
      t.firstByte = ms();
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= MAX_BYTES) chunks.push(c);
        else res.destroy();
      });
      let ended = false;
      // complete: the whole body arrived. A connection that closed early
      // (or a body cut at MAX_BYTES, which is reported as cut instead) is not.
      const finish = (complete) => {
        if (ended) return;
        ended = true;
        t.total = ms();
        const cutHere = size > MAX_BYTES;
        inflate(Buffer.concat(chunks), String(res.headers["content-encoding"] || "")).then((r) =>
          resolve({ status: res.statusCode, headers: res.headers, httpVersion: res.httpVersion, wireBytes: size, body: r.body.toString("utf8"), cut: r.cut || cutHere, broken: !cutHere && (r.broken || !complete), t }),
        );
      };
      res.on("end", () => finish(res.complete !== false));
      res.on("close", () => t.total == null && finish(false));
    });
    req.end();
  });
}

async function fetchLocal(url, timeoutMs, deadline) {
  const hops = [];
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const r = await once(cur, timeoutMs, deadline);
    hops.push({ url: cur, status: r.status, ms: Math.round(r.t.total) });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      continue;
    }
    const t = r.t;
    const dns = t.dns ?? 0;
    const connect = t.connect ?? dns;
    const tls = t.tls ?? connect;
    return {
      local: true, finalUrl: cur, status: r.status, httpVersion: r.httpVersion, redirects: hops.slice(0, -1),
      timing: { dnsMs: Math.round(dns), connectMs: Math.round(connect - dns), tlsMs: t.tls != null ? Math.round(tls - connect) : null, waitMs: Math.round(t.firstByte - tls), downloadMs: Math.round(t.total - t.firstByte), totalMs: Math.round(t.total) },
      redirectMs: hops.slice(0, -1).reduce((a, h) => a + h.ms, 0),
      wireBytes: r.wireBytes, encoding: r.headers["content-encoding"] || null, cacheControl: r.headers["cache-control"] || null, server: r.headers.server || null,
      cut: Boolean(r.cut), broken: Boolean(r.broken), body: r.body,
    };
  }
  throw new Error("Too many redirects");
}

// From an SSH host, with curl. Times come from curl's -w variables.
async function fetchRemote(target, url, timeoutMs) {
  const fmt = "\\n@@CURL %{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{num_redirects} %{time_redirect} %{http_version} %{url_effective}";
  // The URL and options go to curl as a config file on stdin (-K -), so no
  // shell on the host (sh, cmd or PowerShell) ever parses the URL.
  const conf = (k, v) => k + ' = "' + String(v).replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, "") + '"\n';
  const config = conf("url", url) + conf("write-out", fmt) + conf("user-agent", "Mozilla/5.0 jmcp-health") + conf("max-filesize", MAX_BYTES) + conf("max-time", Math.round(timeoutMs / 1000)) + "silent\nshow-error\nlocation\ncompressed\n";
  // -q first: the host's .curlrc must not change what curl does (it could
  // save the page to a file). curl.exe for a Windows PowerShell login shell,
  // where curl is Invoke-WebRequest.
  let r = await ssh(target, "curl -q -K -", config, timeoutMs + 15000);
  if (r.out.lastIndexOf("\n@@CURL ") < 0 && /Invoke-WebRequest|parameter name 'K'|is not recognized/i.test(r.err + r.out)) r = await ssh(target, "curl.exe -q -K -", config, timeoutMs + 15000);
  const i = r.out.lastIndexOf("\n@@CURL ");
  if (i < 0) throw new Error("curl on " + target + " failed: " + (r.err || r.out).trim().slice(-300));
  const [code, dns, conn, tls, ttfb, total, size, redirects, redirectT, ver, eff] = r.out.slice(i + 8).trim().split(" ");
  if (code === "000") throw new Error(target + " could not load " + url + ": " + (r.err.trim().split(/\r?\n/).pop() || "no response"));
  const s = (x) => Math.round(parseFloat(x) * 1000);
  const rt = s(redirectT);
  // curl can fail after the status line: 63 is the 4 MB limit, anything
  // else (timeout, cut connection) means the page did not load completely.
  const curlCode = r.code > 0 ? r.code : 0;
  return {
    cut: curlCode === 63, broken: curlCode > 0 && curlCode !== 63, curlError: curlCode ? (r.err.trim().split(/\r?\n/).pop() || "curl exit " + curlCode) : undefined,
    finalUrl: eff, status: +code, httpVersion: ver, redirects: +redirects ? [{ count: +redirects }] : [],
    timing: { dnsMs: s(dns), connectMs: s(conn) - s(dns), tlsMs: +tls ? s(tls) - s(conn) : null, waitMs: s(ttfb) - (+tls ? s(tls) : s(conn)) - rt, downloadMs: s(total) - s(ttfb), totalMs: s(total) },
    redirectMs: rt, wireBytes: +size, encoding: null, cacheControl: null, server: null,
    body: r.out.slice(0, i),
  };
}

// The first few stylesheets the page links, joined, so @font-face rules in
// them are checked too. Failures are skipped.
async function stylesheets(html, base, timeoutMs, deadline) {
  const hrefs = (html.match(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi) || [])
    .map((l) => (l.match(/href=["']?([^"'\s>]+)/i) || [])[1])
    .filter(Boolean)
    .slice(0, 6);
  const got = await Promise.all(hrefs.map((h) => once(new URL(h.replace(/&amp;/g, "&"), base).toString(), Math.min(timeoutMs, 10000), deadline).then((r) => (r.status === 200 ? r.body : "")).catch(() => "")));
  return got.join("\n");
}

function inspectHtml(html, css) {
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html.slice(0, 20000)])[0];
  const tags = (re, s) => s.match(re) || [];
  const blockingCss = tags(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi, head).filter((l) => !/media=["']?(print|none)/i.test(l) && !/onload=/i.test(l));
  const blockingJs = tags(/<script\b[^>]*\bsrc=[^>]*>/gi, head).filter((s) => !/\b(async|defer)\b|type=["']?module/i.test(s));
  const fontFaces = tags(/@font-face\s*{[^}]*}/gi, html + "\n" + (css || ""));
  const fontNoSwap = fontFaces.filter((f) => !/font-display\s*:\s*(swap|optional|fallback)/i.test(f)).length;
  const googleFonts = tags(/fonts\.googleapis\.com\/css2?\?[^"'\s>]+/gi, html);
  const googleNoSwap = googleFonts.filter((u) => !/display=(swap|optional|fallback)/i.test(u)).length;
  const fontLinks = tags(/(use\.typekit\.net|fonts\.googleapis\.com|fonts\.bunny\.net|use\.fontawesome\.com|kit\.fontawesome\.com)/gi, html);
  const preloadFonts = tags(/<link\b[^>]*rel=["']?preload[^>]*as=["']?font[^>]*>/gi, head).length;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const inlineScripts = tags(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, html).reduce((a, s) => a + s.length, 0);
  const emptyRoot = /<div\s+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
  return {
    htmlKB: Math.round(html.length / 1024), visibleTextChars: text.length, inlineScriptKB: Math.round(inlineScripts / 1024),
    blockingCss: blockingCss.length, blockingJs: blockingJs.length, fontFaces: fontFaces.length, fontNoSwap, googleFonts: googleFonts.length, googleNoSwap,
    thirdPartyFontHosts: [...new Set(fontLinks.map((x) => x.toLowerCase()))], preloadFonts, clientRendered: emptyRoot || (text.length < 200 && html.length > 2000),
    scripts: tags(/<script\b/gi, html).length,
  };
}

function pageProblems(p, h) {
  const out = [];
  const add = (severity, title, evidence, why, fix) => out.push({ severity, area: "page", affects: ["text"], title, evidence, why, fix });
  const t = p.timing;
  if (p.broken) add("medium", "The page did not load or decode completely", p.curlError || "The body could not be decompressed", "A browser shows nothing, or only part of the page, until this is fixed. Font and script findings below may be missing.", "Load the page in a browser and check the server's compression and its logs.");
  if (p.cut) add("info", "Only the first 4 MB of the page was checked", Math.round(p.wireBytes / 1024) + " KB on the wire", "The page is larger than JMCP reads, so fonts and scripts after that point were not checked.", "A page this large is slow by itself; trim the HTML.");
  if (p.status >= 400) add("high", "Page returned HTTP " + p.status, p.finalUrl, "The server answered with an error.", "Check the URL or the server logs.");
  if (t.dnsMs >= 150) add(t.dnsMs >= 500 ? "high" : "medium", "DNS took " + t.dnsMs + " ms", "Before anything else can happen", "The name must resolve before the browser can connect.", "Faster DNS resolver; on the site side, fewer distinct domains.");
  if (t.connectMs >= 150) add("medium", "TCP connect took " + t.connectMs + " ms", "One network round trip", "Far-away server or slow network.", "Use a CDN close to users.");
  if (t.tlsMs != null && t.tlsMs >= 250) add("medium", "TLS handshake took " + t.tlsMs + " ms", "HTTPS setup", "Extra round trips or a slow server CPU for TLS.", "Enable TLS 1.3, session resumption and HTTP/2 or HTTP/3.");
  if (t.waitMs >= 600) add(t.waitMs >= 1500 ? "high" : "medium", "Server took " + t.waitMs + " ms before sending the first byte", "Time to first byte after the connection was ready",
    "Nothing can render until the server sends HTML. This is usually slow database queries, no page cache, or a cold/overloaded server.", "Cache the page or move heavy work out of the request.");
  if (p.redirectMs >= 300) add("medium", "Redirects cost " + p.redirectMs + " ms", JSON.stringify(p.redirects), "Each redirect is a whole extra request before the real page.", "Link straight to the final URL.");
  if (t.downloadMs >= 800) add("medium", "HTML download took " + t.downloadMs + " ms (" + Math.round(p.wireBytes / 1024) + " KB on the wire)", p.encoding ? "Compressed: " + p.encoding : "Not compressed", "Large HTML or a slow link.", "Compress (gzip/br) and trim the HTML.");
  if (p.local && !p.encoding && p.wireBytes > 30000)
    add("low", "HTML is sent uncompressed", Math.round(p.wireBytes / 1024) + " KB", "Compression usually cuts HTML by 70-80%.", "Enable gzip or brotli on the server.");
  if (h.fontNoSwap || h.googleNoSwap)
    add("high", "Web fonts hide text while they load", (h.fontNoSwap ? h.fontNoSwap + " @font-face without font-display: swap. " : "") + (h.googleNoSwap ? h.googleNoSwap + " Google Fonts link(s) without display=swap." : ""),
      "Browsers keep text invisible for up to 3 seconds waiting for these fonts (flash of invisible text). This is the most common reason text 'takes a second' while the rest of the page is there.",
      "Add font-display: swap to each @font-face, or &display=swap to Google Fonts URLs; preload the main font.");
  else if (h.thirdPartyFontHosts.length && !h.preloadFonts)
    add("low", "Fonts load from another domain: " + h.thirdPartyFontHosts.join(", "), "No font preload", "A new domain means another DNS + TLS setup before the font starts downloading.", "Self-host fonts or add <link rel=preconnect> and preload.");
  if (h.blockingCss >= 3) add("medium", h.blockingCss + " render-blocking stylesheets in <head>", "<link rel=stylesheet> without media/onload", "The browser paints nothing until all of them download.", "Combine them and inline critical CSS.");
  if (h.blockingJs >= 1) add(h.blockingJs >= 3 ? "medium" : "low", h.blockingJs + " blocking script(s) in <head>", "<script src> without async/defer", "Parsing stops until each script downloads and runs.", "Add defer or move scripts to the end of <body>.");
  if (h.clientRendered) add("high", "Page text is built by JavaScript", "Only " + h.visibleTextChars + " characters of text in the HTML, " + h.scripts + " scripts",
    "The HTML arrives nearly empty. Text appears only after the JavaScript bundle downloads, parses and runs, which takes longest on slower computers.", "Server-side render or pre-render the page.");
  return out;
}

async function checkPage(target, url, timeoutMs) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  new URL(url);
  const deadline = Date.now() + timeoutMs;
  const p = target === "local" ? await fetchLocal(url, timeoutMs, deadline) : await fetchRemote(target, url, timeoutMs);
  let css = "";
  if (p.local) css = await stylesheets(p.body || "", p.finalUrl, timeoutMs, deadline).catch(() => "");
  const h = inspectHtml(p.body || "", css);
  delete p.body;
  return { page: p, html: h, problems: pageProblems(p, h) };
}

module.exports = { checkPage, inspectHtml, pageProblems, inflate };
