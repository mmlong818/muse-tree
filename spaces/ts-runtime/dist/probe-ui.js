// @bun
// src/probe-ui-cli.ts
import { createHash } from "crypto";
import { createServer as createServer3, connect } from "net";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname as dirname2, join as join2 } from "path";

// src/local-audit-transport.ts
var MAX_CAPTURE_RESPONSE_BYTES = 16 * 1024 * 1024;
var MAX_CAPTURE_REQUEST_BYTES = 1024 * 1024;
async function fulfillLocalAuditRequest(route, socket, url, auditSessionId, signal, onTransportFailure) {
  const request = route.request();
  try {
    const path = new URL(url).pathname;
    const relative = path.match(/^\/spaces\/v2\/hatch-audit-[a-f0-9-]+\/(.*)$/)?.[1];
    const method = request.method();
    const read = method === "GET" && relative !== undefined && (relative === "" || relative === "icon.jpg" || relative === "icon.png" || relative.startsWith("assets/") || relative.startsWith("blobs/"));
    const action = method === "POST" && (relative === "actions" || relative === "actions_stream");
    const body = request.postDataBuffer();
    if (auditSessionId === null || !read && !action || body !== null && body.byteLength > MAX_CAPTURE_REQUEST_BYTES) {
      await route.abort("blockedbyclient");
      return;
    }
    const headers = new Headers({ "x-hatch-audit-session": auditSessionId });
    for (const name of ["accept", "content-type", "range"]) {
      const value = request.headers()[name];
      if (value !== undefined)
        headers.set(name, value);
    }
    const localUrl = new URL(url);
    localUrl.protocol = "http:";
    const response = await fetch(localUrl, {
      unix: socket,
      method,
      headers,
      body,
      redirect: "manual",
      signal
    }).catch((error) => {
      if (!signal.aborted)
        onTransportFailure?.();
      throw error;
    });
    const chunks = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read().catch((error) => {
            if (!signal.aborted)
              onTransportFailure?.();
            throw error;
          });
          if (done)
            break;
          size += value.byteLength;
          if (size > MAX_CAPTURE_RESPONSE_BYTES) {
            throw new Error("Artifact capture response exceeds the size limit");
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
    }
    const responseHeaders = Object.fromEntries(response.headers.entries());
    for (const name of [
      "content-encoding",
      "content-length",
      "transfer-encoding"
    ]) {
      delete responseHeaders[name];
    }
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.concat(chunks)
    });
  } catch {
    await route.abort("failed").catch(() => {});
  }
}

// src/playwright-audit.ts
import { accessSync, constants as fsConstants, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createServer as createServer2, request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { connect as netConnect2, isIP as isIP2 } from "net";

// src/transport-ledger.ts
import { createServer, connect as netConnect, isIP } from "net";
import { connect as tlsConnect } from "tls";
var MAX_TRANSPORT_ENTRIES = 256;
var MAX_TRANSPORT_HOST_CHARS = 255;
function newTransportLedgerState() {
  return { entries: new Map, overflow: 0, udp_attempts: 0 };
}
function recordTransportConnect(state, host, port, flags) {
  const boundedHost = host.toLowerCase().slice(0, MAX_TRANSPORT_HOST_CHARS);
  const key = `${boundedHost}:${port}`;
  const existing = state.entries.get(key);
  if (existing !== undefined) {
    existing.connects += 1;
    return existing;
  }
  if (state.entries.size >= MAX_TRANSPORT_ENTRIES) {
    state.overflow += 1;
    return null;
  }
  const entry = {
    host: boundedHost,
    port,
    connects: 1,
    bytes_up: 0,
    bytes_down: 0
  };
  if (flags.ipLiteral) {
    entry.ip_literal = true;
  }
  state.entries.set(key, entry);
  return entry;
}
function parseSocksGreeting(buf) {
  if (buf.length < 2) {
    return null;
  }
  if (buf[0] !== 5) {
    return null;
  }
  const nMethods = buf[1];
  if (nMethods === undefined || buf.length < 2 + nMethods) {
    return null;
  }
  return 2 + nMethods;
}
function parseSocksRequest(buf) {
  if (buf.length < 5) {
    return null;
  }
  if (buf[0] !== 5) {
    throw new Error("not a SOCKS5 request");
  }
  const cmd = buf[1];
  const atyp = buf[3];
  if (cmd === undefined || atyp === undefined) {
    return null;
  }
  let host;
  let portOffset;
  if (atyp === 1) {
    if (buf.length < 10) {
      return null;
    }
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    portOffset = 8;
  } else if (atyp === 3) {
    const len = buf[4];
    if (len === undefined || buf.length < 5 + len + 2) {
      return null;
    }
    host = buf.subarray(5, 5 + len).toString("latin1");
    portOffset = 5 + len;
  } else if (atyp === 4) {
    if (buf.length < 22) {
      return null;
    }
    const parts = [];
    for (let i = 0;i < 8; i += 1) {
      parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
    }
    host = parts.join(":");
    portOffset = 20;
  } else {
    throw new Error(`unsupported SOCKS address type ${atyp}`);
  }
  const port = buf.readUInt16BE(portOffset);
  return { cmd, host, port, atyp, consumed: portOffset + 2 };
}
function normalizeLedgerHost(host) {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  if (!h.includes(":")) {
    return h;
  }
  const zone = h.indexOf("%");
  if (zone !== -1) {
    h = h.slice(0, zone);
  }
  const halves = h.split("::");
  if (halves.length > 2) {
    return h;
  }
  const first = halves[0] ?? "";
  const second = halves[1] ?? "";
  const head = first === "" ? [] : first.split(":");
  const tail = halves.length === 2 ? second === "" ? [] : second.split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return h;
  }
  return groups.map((g) => String(parseInt(g, 16).toString(16))).join(":");
}
var DEFAULT_SCHEME_PORTS = {
  "https:": "443",
  "wss:": "443",
  "http:": "80",
  "ws:": "80"
};
function ledgerDestinationKey(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const port = parsed.port.length > 0 ? parsed.port : DEFAULT_SCHEME_PORTS[parsed.protocol];
  if (port === undefined) {
    return null;
  }
  return `${normalizeLedgerHost(parsed.hostname)}:${port}`;
}
function parseClientHelloSni(buf) {
  try {
    if (buf.length < 5 || buf[0] !== 22) {
      return null;
    }
    const recordLen = buf.readUInt16BE(3);
    const record = buf.subarray(5, 5 + recordLen);
    if (record.length < 42 || record[0] !== 1) {
      return null;
    }
    let at = 4 + 2 + 32;
    const sessionIdLen = record[at];
    if (sessionIdLen === undefined) {
      return null;
    }
    at += 1 + sessionIdLen;
    const cipherLen = record.readUInt16BE(at);
    at += 2 + cipherLen;
    const compLen = record[at];
    if (compLen === undefined) {
      return null;
    }
    at += 1 + compLen;
    if (at + 2 > record.length) {
      return null;
    }
    const extTotal = record.readUInt16BE(at);
    at += 2;
    const extEnd = Math.min(at + extTotal, record.length);
    while (at + 4 <= extEnd) {
      const extType = record.readUInt16BE(at);
      const extLen = record.readUInt16BE(at + 2);
      at += 4;
      if (extType === 0) {
        if (extLen < 5 || at + extLen > record.length) {
          return null;
        }
        const nameLen = record.readUInt16BE(at + 3);
        if (5 + nameLen > extLen) {
          return null;
        }
        return record.subarray(at + 5, at + 5 + nameLen).toString("latin1");
      }
      at += extLen;
    }
    return null;
  } catch {
    return null;
  }
}
function unexplainedTransportHosts(state, explainedDestinations) {
  const unexplained = new Set;
  for (const entry of state.entries.values()) {
    const host = normalizeLedgerHost(entry.host);
    if (explainedDestinations.has(`${host}:${entry.port}`)) {
      continue;
    }
    unexplained.add(`${host.includes(":") ? `[${host}]` : host}:${entry.port}`);
  }
  return [...unexplained].sort();
}
var SOCKS_REPLY_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
var SOCKS_REPLY_REFUSED = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
var SOCKS_REPLY_CMD_UNSUPPORTED = Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]);
function parseUpstream(upstreamProxyUrl) {
  if (upstreamProxyUrl === null) {
    return null;
  }
  const url = new URL(upstreamProxyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported upstream proxy protocol: ${url.protocol}`);
  }
  const tls = url.protocol === "https:";
  return {
    host: url.hostname.replace(/^\[/, "").replace(/\]$/, ""),
    port: url.port.length > 0 ? Number(url.port) : tls ? 443 : 80,
    tls
  };
}
function dialUpstream(upstream, host, port) {
  return new Promise((resolve, reject) => {
    if (upstream === null) {
      const direct = netConnect(port, host);
      direct.once("connect", () => resolve(direct));
      direct.once("error", reject);
      return;
    }
    const socket = upstream.tls ? tlsConnect({
      host: upstream.host,
      port: upstream.port,
      servername: isIP(upstream.host) ? undefined : upstream.host
    }) : netConnect(upstream.port, upstream.host);
    const readyEvent = upstream.tls ? "secureConnect" : "connect";
    socket.once("error", reject);
    socket.once(readyEvent, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r
Host: ${host}:${port}\r
\r
`);
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf(`\r
\r
`);
        if (headerEnd === -1) {
          if (buffer.length > 16384) {
            socket.removeListener("data", onData);
            socket.destroy();
            reject(new Error("oversized upstream CONNECT response"));
          }
          return;
        }
        socket.removeListener("data", onData);
        const statusLine = buffer.subarray(0, buffer.indexOf(`\r
`)).toString("latin1");
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          socket.destroy();
          reject(new Error(`upstream CONNECT refused: ${statusLine.slice(0, 80)}`));
          return;
        }
        const leftover = buffer.subarray(headerEnd + 4);
        if (leftover.length > 0) {
          socket.unshift(leftover);
        }
        resolve(socket);
      };
      socket.on("data", onData);
    });
  });
}
async function startTransportLedger(upstreamProxyUrl, options) {
  const upstream = parseUpstream(upstreamProxyUrl);
  const allowedDestinations = options?.allowedDestinations ?? null;
  const state = newTransportLedgerState();
  const sockets = new Set;
  const server = createServer((client) => {
    sockets.add(client);
    let phase = "greeting";
    let buffer = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    client.on("close", () => sockets.delete(client));
    client.on("data", (chunk) => {
      if (phase === "tunnel") {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        const consumed = parseSocksGreeting(buffer);
        if (consumed === null) {
          if (buffer.length > 512) {
            client.destroy();
          }
          return;
        }
        client.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(consumed);
        phase = "request";
      }
      if (phase === "request") {
        let request;
        try {
          request = parseSocksRequest(buffer);
        } catch {
          client.end(SOCKS_REPLY_REFUSED);
          return;
        }
        if (request === null) {
          if (buffer.length > 4096) {
            client.destroy();
          }
          return;
        }
        buffer = buffer.subarray(request.consumed);
        if (request.cmd !== 1) {
          state.udp_attempts += 1;
          client.end(SOCKS_REPLY_CMD_UNSUPPORTED);
          return;
        }
        phase = "tunnel";
        const entry = recordTransportConnect(state, request.host, request.port, {
          ipLiteral: request.atyp !== 3
        });
        if (allowedDestinations !== null && !allowedDestinations.has(`${normalizeLedgerHost(request.host)}:${request.port}`)) {
          if (entry !== null) {
            entry.policy_denied = true;
          }
          client.end(SOCKS_REPLY_REFUSED);
          return;
        }
        client.pause();
        dialUpstream(upstream, request.host, request.port).then((remote) => {
          sockets.add(remote);
          remote.on("close", () => sockets.delete(remote));
          client.write(SOCKS_REPLY_OK);
          let sawFirst = false;
          client.on("data", (data) => {
            if (entry !== null) {
              entry.bytes_up += data.length;
              if (!sawFirst) {
                sawFirst = true;
                const sni = parseClientHelloSni(data);
                if (sni !== null && request !== null && request.atyp === 3 && sni.toLowerCase() !== request.host.toLowerCase()) {
                  entry.sni_mismatch = true;
                }
              }
            }
          });
          remote.on("data", (data) => {
            if (entry !== null) {
              entry.bytes_down += data.length;
            }
          });
          if (buffer.length > 0) {
            client.unshift(buffer);
            buffer = Buffer.alloc(0);
          }
          client.pipe(remote);
          remote.pipe(client);
          const teardown = () => {
            client.destroy();
            remote.destroy();
          };
          client.on("close", teardown);
          remote.on("close", teardown);
          remote.on("error", teardown);
          client.resume();
        }).catch(() => {
          if (entry !== null) {
            entry.denied = true;
          }
          try {
            client.end(SOCKS_REPLY_REFUSED);
          } catch {}
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("transport ledger failed to bind");
  }
  return {
    server: `socks5://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    })
  };
}

// src/playwright-audit.ts
import { connect as tlsConnect2 } from "tls";

// src/probe-ui-observe.ts
var NODE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role]",
  "[onclick]",
  "[contenteditable='true']",
  "h1",
  "h2",
  "h3",
  "li",
  "td",
  "th"
].join(",");
var OBSERVE_ATTR = "data-hatch-obs";
var INTERACTIVE_TAGS = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "summary"
]);
var INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "combobox",
  "textbox",
  "slider",
  "option"
]);
var SETTLE_POLL_TIMEOUT_MS = 8000;
var SETTLE_POLL_INTERVAL_MS = 100;
var SETTLE_STABLE_POLLS = 2;
var MAX_OBSERVE_NODES = 120;
var MAX_CLIP_SCAN = 4000;
var CLIP_MIN_PX = 3;
function isUselessName(name) {
  const trimmed = name.trim();
  if (trimmed.length === 0)
    return true;
  return !/[\p{L}\p{N}]/u.test(trimmed);
}
function observeWalkScript(selector, attr, maxNodes) {
  return `(() => {
  // Clear the previous walk's numbering FIRST.
  //
  // The attribute is how \`act\` addresses a node, and it is set only on the
  // elements a walk emits. An element that was node 13 last walk and drops out of
  // this one \u2014 scrolled away, covered by a modal, unmounted-but-reused \u2014 keeps
  // \`13\`, so when this walk gives 13 to something else the locator matches two
  // elements and the act fails \`stale_node\`. That is the strict-mode ambiguity
  // this probe exists to remove, reintroduced by its own bookkeeping: in
  // production it cost 4 of one run's 14 batch calls, one of them abandoning a
  // 12-step flow at step 1.
  for (const stale of Array.from(document.querySelectorAll("[" + ${JSON.stringify(attr)} + "]"))) {
    stale.removeAttribute(${JSON.stringify(attr)});
  }
  const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const interactiveTags = new Set(${JSON.stringify([...INTERACTIVE_TAGS])});
  const interactiveRoles = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
  const out = [];
  const unreachable = [];
  let needsInnerScroll = 0;
  let interactive = 0;
  let candidates = 0;

  const label = (el) => {
    const n = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      (el.textContent || "")
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    return n || el.tagName.toLowerCase();
  };
  const brief = (el) => {
    if (el === null) return "unknown";
    const cls = (el.getAttribute("class") || "").split(/\\s+/).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  // Effective, not own. getComputedStyle(el).opacity is the element's OWN
  // opacity: a child of an opacity-0 ancestor computes 1, and elementFromPoint
  // happily hits a fully transparent element. Checking only the element made the
  // walk report an 'opacity-0 group-hover:opacity-100' delete button as visible
  // AND interactive at 390px, manufacturing confidence about a control a phone
  // user cannot see.
  // aria-hidden / inert is the platform's own "not currently available" marker.
  // A closed off-canvas drawer sits outside the body's clip, so without this it
  // reports every one of its buttons as clipped_off on every audit.
  const inUnavailableSubtree = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      if (n.getAttribute("aria-hidden") === "true") return true;
      if (n.hasAttribute("inert")) return true;
    }
    return false;
  };
  // An open dialog legitimately covers the page. Treating that as a defect would
  // flag every background control whenever an audit lands with a modal open.
  const isModalOverlay = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      const role = n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (n.getAttribute("aria-modal") === "true") return true;
      const b = n.getBoundingClientRect();
      const covers = (b.width * b.height) / Math.max(window.innerWidth * window.innerHeight, 1);
      const pos = getComputedStyle(n).position;
      if (covers > 0.6 && (pos === "fixed" || pos === "absolute")) return true;
    }
    return false;
  };
  const effectivelyInvisible = (el) => {
    for (let n = el; n !== null && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === "hidden" || s.display === "none") return true;
      if (Number(s.opacity) === 0) return true;
    }
    return false;
  };
  // The nearest ancestor that clips or scrolls, and whether it can reach the rect.
  const clipStatus = (el, r) => {
    const area = Math.max(r.width * r.height, 1);
    for (let n = el.parentElement; n !== null && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const ox = s.overflowX, oy = s.overflowY;
      const clipsX = ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll";
      const clipsY = oy === "hidden" || oy === "clip" || oy === "auto" || oy === "scroll";
      if (!clipsX && !clipsY) continue;
      const b = n.getBoundingClientRect();
      // Fraction of the control the scrollport hides. A sliver left showing is as
      // unusable as none; a 2px trim is not a defect, so require most of it gone.
      const vw = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
      const vh = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
      const hiddenFrac = 1 - (vw * vh) / area;
      if (hiddenFrac < 0.5) return null;
      const offX = r.right > b.right || r.left < b.left;
      const offY = r.bottom > b.bottom || r.top < b.top;
      const scrollableX = (ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1;
      const scrollableY = (oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1;
      // A carousel the user can swipe to is not a defect; overflow hidden, or a
      // scrollport with no scroll range in the offending axis, is.
      if ((offX && scrollableX) || (offY && scrollableY)) {
        return { reachable: true, by: brief(n), px: 0 };
      }
      const px = Math.round(Math.max(
        r.right - b.right, b.left - r.left, r.bottom - b.bottom, b.top - r.top, 1));
      return { reachable: false, by: brief(n), px };
    }
    return null;
  };
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.top > window.innerHeight * 3) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const isInteractive =
      interactiveTags.has(tag) ||
      (role !== null && interactiveRoles.has(role)) ||
      el.hasAttribute("onclick") ||
      el.getAttribute("contenteditable") === "true";

    // Classify why a control is unusable rather than dropping it silently. A
    // dropped node tells the model nothing; "this button is under your fixed
    // FAB" tells it what to fix.
    // Not a defect and not a node: the author has marked this subtree
    // unavailable, so neither report it nor offer it as an act target.
    if (inUnavailableSubtree(el)) continue;
    if (effectivelyInvisible(el)) {
      if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "invisible",
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    const clip = clipStatus(el, r);
    if (clip !== null) {
      if (clip.reachable) {
        needsInnerScroll += 1;
      } else if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "clipped_off",
          clipped_by: clip.by, overflow_px: clip.px,
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    let hit = true;
    let occluder = null;
    if (r.top >= 0 && r.bottom <= window.innerHeight) {
      // Five samples, not one. The shipped defect was a fixed FAB shearing the
      // primary CTA: part covered, centre clear, invisible to a centre-only test.
      const probes = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      let covered = 0;
      for (const [fx, fy] of probes) {
        const px = Math.min(Math.max(r.x + r.width * fx, 1), window.innerWidth - 1);
        const py = Math.min(Math.max(r.y + r.height * fy, 1), window.innerHeight - 1);
        const at = document.elementFromPoint(px, py);
        if (at === null || el.contains(at) || at.contains(el)) continue;
        if (isModalOverlay(at)) { covered = 0; break; }
        covered += 1;
        if (occluder === null) occluder = at;
      }
      // A majority covered is substantial; a clipped edge is not a defect.
      hit = covered < 3;
      if (hit) occluder = null;
    }
    if (!hit) {
      if (isInteractive && unreachable.length < 25) {
        unreachable.push({ name: label(el), tag, reason: "occluded",
          occluder: brief(occluder),
          bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
      continue;
    }
    candidates += 1;
    if (isInteractive) interactive += 1;
    if (out.length >= ${maxNodes}) continue;
    const name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      (el.textContent || "")
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    const i = out.length + 1;
    el.setAttribute(${JSON.stringify(attr)}, String(i));
    out.push({
      i,
      role,
      name,
      tag,
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      enabled: !(el.disabled === true || el.getAttribute("aria-disabled") === "true"),
      interactive: isInteractive,
    });
  }
  // Second pass, wider scope: clipping lives on text-bearing spans, paragraphs
  // and table cells, which are not act targets and so are absent from the list
  // above. Every visual defect these audits historically missed was this shape \u2014
  // a column truncated to "DA AP", a badge cut at its parent's edge, a heading
  // clipped at the viewport \u2014 so scan for it directly instead of leaving it to
  // whoever opens the screenshot.
  const clipped = [];
  let scanned = 0;
  for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : [])) {
    if (scanned >= ${MAX_CLIP_SCAN}) break;
    scanned += 1;
    if (clipped.length >= 20) break;
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
    );
    if (!own) continue;
    const r2 = el.getBoundingClientRect();
    if (r2.width <= 0 || r2.height <= 0) continue;
    const cs2 = getComputedStyle(el);
    if (cs2.visibility === "hidden" || cs2.display === "none") continue;
    const truncPx = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
    const pastPx = r2.right - window.innerWidth;
    const kind = truncPx >= ${CLIP_MIN_PX}
      ? "text_truncated"
      : pastPx >= ${CLIP_MIN_PX}
        ? "past_viewport"
        : null;
    if (kind === null) continue;
    clipped.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      kind,
      overflow_px: Math.round(kind === "text_truncated" ? truncPx : pastPx),
      bbox: [Math.round(r2.x), Math.round(r2.y), Math.round(r2.width), Math.round(r2.height)],
    });
  }
  return {
    nodes: out,
    interactive_nodes: interactive,
    total_candidates: candidates,
    truncated: candidates > out.length,
    clipped,
    unreachable,
    needs_inner_scroll: needsInnerScroll,
  };
})()`;
}
function freezeTimeScript(epochMs) {
  return `(() => {
  const FIXED = ${epochMs};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) { super(FIXED); } else { super(...args); }
    }
    static now() { return FIXED; }
  }
  // Keep instanceof and the prototype chain intact for libraries that check.
  Object.defineProperty(FrozenDate, "name", { value: "Date" });
  globalThis.Date = FrozenDate;
  if (globalThis.performance) {
    let t = 0;
    globalThis.performance.now = () => (t += 16);
  }
  // Deterministic LCG so seeded shuffles/ids repeat across audit rounds.
  let seed = 0x2f6e2b1;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
})()`;
}
var SCENARIO_CLOCK_OFFSET_MS = (() => {
  const raw = Number((process.env.HATCH_SPACES_PAGE_EPOCH_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw - Date.now() : null;
})();
async function pollSdkIdle(page, timeoutMs) {
  const startedAt = Date.now();
  const probe = async () => {
    try {
      return await page.evaluate("typeof window.__hatchAuditSettle === 'function' ? window.__hatchAuditSettle() : null");
    } catch {
      return null;
    }
  };
  const first = await probe();
  if (first === null)
    return null;
  let idleStreak = 0;
  let last = first;
  while (Date.now() - startedAt < timeoutMs) {
    last = await probe() ?? 0;
    idleStreak = last === 0 ? idleStreak + 1 : 0;
    if (idleStreak >= SETTLE_STABLE_POLLS) {
      return { settled: true, settle_ms: Date.now() - startedAt, in_flight: 0 };
    }
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
  }
  return { settled: false, settle_ms: Date.now() - startedAt, in_flight: last };
}
async function settlePage(page, networkIdleFallbackMs) {
  const startedAt = Date.now();
  const sdk = await pollSdkIdle(page, SETTLE_POLL_TIMEOUT_MS);
  if (sdk !== null)
    return sdk;
  let idle = true;
  await page.waitForLoadState("networkidle", { timeout: networkIdleFallbackMs }).catch(() => {
    idle = false;
  });
  return { settled: idle, settle_ms: Date.now() - startedAt, in_flight: null };
}
async function observeNodes(page) {
  return await page.evaluate(observeWalkScript(NODE_SELECTOR, OBSERVE_ATTR, MAX_OBSERVE_NODES));
}
async function ariaSnapshot(page) {
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    return null;
  }
}
function clippedNodes(walk) {
  return (walk.clipped ?? []).filter((c) => c.text.trim().length > 0);
}
function unnamedInteractiveNodes(walk) {
  return walk.nodes.filter((n) => n.interactive && isUselessName(n.name));
}

// src/playwright-audit.ts
var DESKTOP_VIEWPORT = { width: 1440, height: 900 };
var MOBILE_VIEWPORT = { width: 390, height: 844 };
var PAGE_LOAD_TIMEOUT_MS = 15000;
var SETTLE_TIMEOUT_MS = 4000;
var SYSTEM_CHROME_PATHS = [
  ...process.platform === "linux" && process.arch === "x64" ? ["/opt/hatch/assets/artifacts/headless-shell/chrome-headless-shell"] : [],
  "/opt/meta-chromium/chrome"
];
var PW_DEFAULT_DISABLED_FEATURES = "AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate";
var CHROME_HARDENING_ARGS = [
  "--disable-sync",
  "--disable-domain-reliability",
  "--disable-component-update",
  "--disable-http2",
  "--disable-quic",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy",
  `--disable-features=${PW_DEFAULT_DISABLED_FEATURES},OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication`
];
var CHROME_PHONE_HOME_BYPASS_HOSTS = [
  "accounts.google.com",
  "www.google.com",
  "clients2.google.com",
  "android.clients.google.com",
  "*.gvt1.com",
  "optimizationguide-pa.googleapis.com",
  "update.googleapis.com",
  "content-autofill.googleapis.com"
];
var CHROME_DNS_BLACKHOLE_IP = "0.0.0.0";
function buildHostResolverRulesArg(proxyServer) {
  if (proxyServer === null) {
    return null;
  }
  let proxyHost;
  try {
    proxyHost = new URL(proxyServer).hostname;
  } catch {
    return null;
  }
  if (proxyHost.length === 0) {
    return null;
  }
  const socks = proxyServer.startsWith("socks5://");
  const rules = [
    `MAP ${proxyHost} ${proxyHost}`,
    ...CHROME_PHONE_HOME_BYPASS_HOSTS.map((host) => `MAP ${host} ${CHROME_DNS_BLACKHOLE_IP}`)
  ];
  if (socks) {
    rules.push("MAP * ~NOTFOUND");
    rules.push("EXCLUDE 127.0.0.1");
    rules.push("EXCLUDE localhost");
  }
  return `--host-resolver-rules=${rules.join(",")}`;
}
var MAX_EXTERNAL_BLOCKED_IMAGE_SAMPLE = 5;
var FAILED_IMAGE_RESPONSE_STATUSES = new Set([401, 403, 404]);
var FAILED_ASSET_RESOURCE_TYPES = new Set([
  "stylesheet",
  "script",
  "font",
  "fetch",
  "xhr",
  "media"
]);
var FAILED_ASSET_MIN_ERROR_STATUS = 400;
var EXPIRING_HOST_SUFFIXES = ["cdninstagram.com", "fbcdn.net"];
var EXPIRING_QUERY_PARAMS = new Set([
  "expires",
  "oe",
  "oh",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-expires",
  "x-goog-signature",
  "key-pair-id"
]);
function classifyImageSource(rawSrc, ownOrigin) {
  if (typeof rawSrc !== "string" || rawSrc.trim().length === 0) {
    return { unstable: false, reason: null };
  }
  let parsed;
  try {
    parsed = new URL(rawSrc.trim());
  } catch {
    return { unstable: false, reason: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { unstable: false, reason: null };
  }
  if (typeof ownOrigin === "string" && ownOrigin.length > 0 && parsed.origin === ownOrigin) {
    return { unstable: false, reason: null };
  }
  const host = parsed.hostname.toLowerCase();
  for (const suffix of EXPIRING_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return { unstable: true, reason: `expiring/origin-locked host (${suffix})` };
    }
  }
  for (const key of parsed.searchParams.keys()) {
    if (EXPIRING_QUERY_PARAMS.has(key.toLowerCase())) {
      return { unstable: true, reason: `signed/expiring URL param (${key})` };
    }
  }
  return { unstable: false, reason: null };
}
var MAX_LOGGED_BLOCKED_REQUESTS = 20;
var MAX_LOGGED_CONSOLE_ERRORS = 20;
var MAX_LOGGED_CONSOLE_WARNINGS = 20;
var MAX_LOGGED_BROKEN_ASSETS = 20;
var MAX_LOGGED_TEXT_ISSUES = 10;
var MAX_EXTERNAL_REQUESTS = 40;
var MAX_EXTERNAL_GENERIC_REQUESTS = 32;
var MAX_EXTERNAL_REQUEST_URL_CHARS = 2048;
var MAX_EXTERNAL_REQUEST_BODY_CHARS = 1024;
var MAX_EXTERNAL_REQUEST_HEADERS = 12;
var MAX_EXTERNAL_REQUEST_HEADER_NAME_CHARS = 128;
var MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS = 256;
function sliceCodepointSafe(text, max) {
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 55296 && last <= 56319) {
    cut = cut.slice(0, -1);
  }
  return cut;
}
var EXTERNAL_REQUEST_BOILERPLATE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "host",
  "origin",
  "pragma",
  "priority",
  "upgrade-insecure-requests",
  "user-agent"
]);
var CHROMIUM_GENERATED_HEADER_PREFIXES = [
  "sec-ch-",
  "sec-fetch-",
  "sec-websocket-"
];
function isDataBearingRequest(method, resourceType) {
  const verb = method.toUpperCase();
  return verb !== "GET" && verb !== "HEAD" || resourceType === "websocket" || resourceType === "popup";
}
function newExternalRequestLog() {
  return {
    requests: [],
    seen: new Set,
    dropped: 0,
    dropped_data_bearing: 0,
    generic: 0
  };
}
function recordExternalRequest(log, request, daemonOrigin) {
  const body = request.postData ?? undefined;
  let truncated = false;
  const kept = {};
  let keptCount = 0;
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    if (keptCount >= MAX_EXTERNAL_REQUEST_HEADERS) {
      truncated = true;
      break;
    }
    const name = rawName.toLowerCase();
    if (name.startsWith(":"))
      continue;
    if (CHROMIUM_GENERATED_HEADER_PREFIXES.some((p) => name.startsWith(p)))
      continue;
    if (name === "referer") {
      const refererOrigin = safeOrigin(value);
      if (refererOrigin === null || refererOrigin === daemonOrigin)
        continue;
    } else if (EXTERNAL_REQUEST_BOILERPLATE_HEADERS.has(name)) {
      continue;
    }
    if (name.length > MAX_EXTERNAL_REQUEST_HEADER_NAME_CHARS) {
      truncated = true;
      continue;
    }
    if (value.length > MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS) {
      kept[name] = sliceCodepointSafe(value, MAX_EXTERNAL_REQUEST_HEADER_VALUE_CHARS);
      truncated = true;
    } else {
      kept[name] = value;
    }
    keptCount += 1;
  }
  const headerKey = Object.entries(kept).map(([name, value]) => `${name}=${value.slice(0, 64)}`).sort().join(" ");
  const key = `${request.method} ${request.resourceType} ${request.url.slice(0, MAX_EXTERNAL_REQUEST_URL_CHARS * 2)} ${body === undefined ? "" : body.slice(0, MAX_EXTERNAL_REQUEST_BODY_CHARS)} ${headerKey}`;
  if (log.seen.has(key))
    return;
  log.seen.add(key);
  const dataBearing = isDataBearingRequest(request.method, request.resourceType);
  const atTotalCap = log.requests.length >= MAX_EXTERNAL_REQUESTS;
  if (atTotalCap || !dataBearing && log.generic >= MAX_EXTERNAL_GENERIC_REQUESTS) {
    log.dropped += 1;
    if (dataBearing) {
      log.dropped_data_bearing += 1;
    }
    return;
  }
  let url = request.url;
  if (url.length > MAX_EXTERNAL_REQUEST_URL_CHARS) {
    url = sliceCodepointSafe(url, MAX_EXTERNAL_REQUEST_URL_CHARS);
    truncated = true;
  }
  const entry = {
    url,
    method: request.method,
    resource_type: request.resourceType
  };
  if (body !== undefined && body.length > 0) {
    if (body.length > MAX_EXTERNAL_REQUEST_BODY_CHARS) {
      entry.post_data = sliceCodepointSafe(body, MAX_EXTERNAL_REQUEST_BODY_CHARS);
      truncated = true;
    } else {
      entry.post_data = body;
    }
  }
  if (keptCount > 0) {
    entry.headers = kept;
  }
  if (truncated) {
    entry.truncated = true;
  }
  if (!dataBearing) {
    log.generic += 1;
  }
  log.requests.push(entry);
}
function safeOrigin(requestUrl) {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
}
function formatConsoleLine(prefix, text, locationUrl) {
  const trimmed = locationUrl.trim();
  if (trimmed.length === 0 || text.includes(trimmed)) {
    return `${prefix}: ${text}`;
  }
  return `${prefix}: ${text} (${trimmed})`;
}
function formatConsoleError(text, locationUrl) {
  return formatConsoleLine("console.error", text, locationUrl);
}
function formatConsoleWarning(text, locationUrl) {
  return formatConsoleLine("console.warn", text, locationUrl);
}
var HIGH_PRIORITY_WARNING_PATTERNS = [
  "hydrat",
  "did not match",
  "should have a unique",
  "deprecat",
  "content security policy",
  "preloaded using link preload",
  "either width or height",
  "aspect ratio"
];
function isHighPriorityWarning(text) {
  const lowered = text.toLowerCase();
  return HIGH_PRIORITY_WARNING_PATTERNS.some((pattern) => lowered.includes(pattern));
}
function isDaemonRootFaviconRequest(locationUrl, daemonOrigin) {
  try {
    const parsed = new URL(locationUrl);
    return parsed.origin === daemonOrigin && parsed.pathname === "/favicon.ico";
  } catch {
    return false;
  }
}
function isAuditRequestAllowed(requestUrl, daemonOrigin, routeSlug) {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.origin !== daemonOrigin)
    return true;
  const spacePrefix = `/spaces/v2/${routeSlug}/`;
  const spaceExact = `/spaces/v2/${routeSlug}`;
  return parsed.pathname === spaceExact || parsed.pathname.startsWith(spacePrefix);
}
function rewriteLegacyAuditBlobUrl(requestUrl, daemonOrigin, canonicalSlug, routeSlug, transport) {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  const canonicalPrefix = `/spaces/v2/${canonicalSlug}/blobs/`;
  if (parsed.origin !== daemonOrigin || !parsed.pathname.startsWith(canonicalPrefix)) {
    return null;
  }
  const key = parsed.pathname.slice(canonicalPrefix.length);
  parsed.pathname = transport === "local" ? `/spaces/v2/${routeSlug}/blobs/${key}` : `/spaces/v2/${routeSlug}/spaces/v2/${canonicalSlug}/blobs/${key}`;
  return parsed.toString();
}
async function readAuditTokensFromStdin() {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const settle = () => {
      if (settled)
        return;
      settled = true;
      try {
        process.stdin.pause();
      } catch {}
      const lines = buf.split(`
`);
      const notaryLine = (lines[0] ?? "").trim();
      const proxyLine = (lines[1] ?? "").trim();
      resolve({
        notaryToken: notaryLine.startsWith("endorsement.") ? notaryLine : null,
        proxyAuthToken: proxyLine.length > 0 ? proxyLine : null
      });
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += String(chunk);
      if (buf.split(`
`).length >= 3) {
        settle();
      }
    });
    process.stdin.on("end", settle);
    process.stdin.on("error", settle);
  });
}
function resolveBundledPlaywrightCli() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "node_modules", "playwright", "cli.js");
}
function findSystemChrome() {
  for (const candidate of SYSTEM_CHROME_PATHS) {
    if (!existsSync(candidate))
      continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
async function ensureChromium() {
  const cli = resolveBundledPlaywrightCli();
  if (!existsSync(cli)) {
    throw new Error(`bundled playwright cli not found at ${cli}`);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", cli, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`playwright install chromium exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}
async function loadPlaywright() {
  const mod = await import("playwright");
  return mod;
}
function dedupeAndSample(urls) {
  const counts = new Map;
  for (const u of urls)
    counts.set(u, (counts.get(u) ?? 0) + 1);
  const duplicate = [];
  const sample_urls = [];
  let sampleBudget = 6;
  for (const [src, count] of counts.entries()) {
    if (count > 1)
      duplicate.push({ src, count });
    if (sampleBudget > 0) {
      sample_urls.push(src);
      sampleBudget -= 1;
    }
  }
  return { duplicate, sample_urls };
}
var MAX_IMAGE_SAMPLE = 12;
function isSvgSource(src) {
  try {
    return new URL(src, "http://_local_").pathname.toLowerCase().endsWith(".svg");
  } catch {
    return (src.toLowerCase().split("?")[0] ?? src.toLowerCase()).endsWith(".svg");
  }
}
function summarizeImages(rawImages, failedResponses, ownOrigin, egressLockdown = false) {
  const failed = [];
  for (const failure of failedResponses) {
    if (!failure || typeof failure.url !== "string" || failure.url.length === 0)
      continue;
    if (failed.length < MAX_IMAGE_SAMPLE) {
      failed.push({ url: failure.url, status: failure.status });
    }
  }
  const broken = [];
  const unstable = [];
  const unstableSeen = new Set;
  const externalBlocked = [];
  let externalBlockedCount = 0;
  const sources = [];
  for (const img of rawImages) {
    if (!img.src)
      continue;
    sources.push(img.src);
    if (img.complete && (img.nw === 0 || img.nh === 0) && !isSvgSource(img.src)) {
      const srcOrigin = safeOrigin(img.src);
      const external = egressLockdown && typeof ownOrigin === "string" && ownOrigin.length > 0 && /^https?:/i.test(img.src) && srcOrigin !== null && srcOrigin !== "null" && srcOrigin !== ownOrigin;
      if (external) {
        externalBlockedCount += 1;
        if (externalBlocked.length < MAX_EXTERNAL_BLOCKED_IMAGE_SAMPLE) {
          externalBlocked.push(img.src);
        }
      } else {
        broken.push({ src: img.src, alt: img.alt, reason: "not_loaded_or_zero_size" });
      }
    }
    const classification = classifyImageSource(img.src, ownOrigin);
    if (classification.unstable && classification.reason && !unstableSeen.has(img.src)) {
      unstableSeen.add(img.src);
      if (unstable.length < MAX_IMAGE_SAMPLE) {
        unstable.push({ src: img.src, reason: classification.reason });
      }
    }
  }
  const { duplicate, sample_urls } = dedupeAndSample(sources);
  const verdict = broken.length > 0 || unstable.length > 0 ? "fail" : "pass";
  return {
    total: rawImages.length,
    broken,
    duplicate,
    unstable,
    failed_requests: failed,
    external_blocked: { count: externalBlockedCount, sample: externalBlocked },
    sample_urls,
    verdict
  };
}
function buildLaunchOptions(executablePath, proxyServer, proxyAuthToken, _proxyAuthUsername) {
  const launchOptions = {
    headless: true,
    args: [...CHROME_HARDENING_ARGS]
  };
  const hostResolverRulesArg = buildHostResolverRulesArg(proxyServer);
  if (hostResolverRulesArg !== null) {
    launchOptions.args = [...launchOptions.args ?? [], hostResolverRulesArg];
  }
  if (executablePath !== null) {
    launchOptions.executablePath = executablePath;
  }
  if (proxyServer !== null) {
    if (proxyAuthToken !== null) {
      throw new Error("proxy auth token must be routed through relay before launching Chromium");
    }
    const bypass = CHROME_PHONE_HOME_BYPASS_HOSTS.join(",");
    launchOptions.proxy = { server: proxyServer, bypass };
  }
  return launchOptions;
}
function isExternalFetchFailure(text, locationUrl, daemonOrigin) {
  if (!/net::ERR_[A-Z_]+/.test(text) && !/failed to load resource/i.test(text)) {
    return false;
  }
  const candidates = [locationUrl, ...text.match(/https?:\/\/[^\s"')]+/g) ?? []];
  return candidates.some((candidate) => {
    if (!/^https?:\/\//i.test(candidate))
      return false;
    const origin = safeOrigin(candidate);
    return origin !== null && origin !== "null" && origin !== daemonOrigin;
  });
}
var MAX_EXTERNAL_FETCH_FAILURE_SAMPLES = 5;
function installPageDiagnostics(page, consoleErrors, failedImageResponses, daemonOrigin, consoleWarnings = [], brokenAssets = [], externalFetchFailures = {
  count: 0,
  samples: []
}, egressLockdown = false) {
  page.on("pageerror", (err) => {
    if (consoleErrors.length >= MAX_LOGGED_CONSOLE_ERRORS)
      return;
    consoleErrors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    const type = msg.type();
    const locationUrl = msg.location().url;
    if (type === "error") {
      if (isDaemonRootFaviconRequest(locationUrl, daemonOrigin))
        return;
      const text = msg.text();
      if (egressLockdown && isExternalFetchFailure(text, locationUrl, daemonOrigin)) {
        externalFetchFailures.count += 1;
        if (externalFetchFailures.samples.length < MAX_EXTERNAL_FETCH_FAILURE_SAMPLES) {
          externalFetchFailures.samples.push(formatConsoleError(text, locationUrl));
        }
        return;
      }
      if (consoleErrors.length >= MAX_LOGGED_CONSOLE_ERRORS)
        return;
      consoleErrors.push(formatConsoleError(text, locationUrl));
      return;
    }
    if (type === "warning") {
      if (consoleWarnings.length >= MAX_LOGGED_CONSOLE_WARNINGS)
        return;
      const text = msg.text();
      if (!isHighPriorityWarning(text))
        return;
      consoleWarnings.push(formatConsoleWarning(text, locationUrl));
    }
  });
  page.on("response", (response) => {
    try {
      const resourceType = response.request().resourceType();
      const status = response.status();
      if (resourceType === "image") {
        if (FAILED_IMAGE_RESPONSE_STATUSES.has(status)) {
          failedImageResponses.push({ url: response.url(), status });
        }
        return;
      }
      if (FAILED_ASSET_RESOURCE_TYPES.has(resourceType) && status >= FAILED_ASSET_MIN_ERROR_STATUS && brokenAssets.length < MAX_LOGGED_BROKEN_ASSETS) {
        brokenAssets.push({
          url: response.url(),
          status,
          resource_type: resourceType
        });
      }
    } catch {}
  });
}
var ROUTED_CONTEXTS = new WeakSet;
async function attachAuditNetworkPolicy(page, url, canonicalSlug, routeSlug, notaryToken, auditSessionId, blockedRequests, externalRequests, sandboxApiSocket = null, onTransportFailure) {
  const daemonOrigin = new URL(url).origin;
  const daemonHost = new URL(url).host;
  const context = page.context();
  if (ROUTED_CONTEXTS.has(context)) {
    return daemonOrigin;
  }
  ROUTED_CONTEXTS.add(context);
  const localRequests = new AbortController;
  context.on("close", () => localRequests.abort());
  const recordWebSockets = (target) => {
    target.on("websocket", (ws) => {
      const wsUrl = ws.url();
      let wsHost = null;
      try {
        wsHost = new URL(wsUrl).host;
      } catch {
        wsHost = null;
      }
      if (wsHost !== null && wsHost !== daemonHost) {
        recordExternalRequest(externalRequests, { url: wsUrl, method: "GET", resourceType: "websocket" }, daemonOrigin);
      }
    });
  };
  recordWebSockets(page);
  context.on("page", (popup) => {
    recordWebSockets(popup);
    let recorded = false;
    const recordPopupUrl = () => {
      if (recorded)
        return;
      const popupUrl = popup.url();
      if (popupUrl.length === 0 || popupUrl === "about:blank")
        return;
      const origin = safeOrigin(popupUrl);
      if (origin === null || origin === daemonOrigin)
        return;
      recorded = true;
      recordExternalRequest(externalRequests, { url: popupUrl, method: "GET", resourceType: "popup" }, daemonOrigin);
    };
    try {
      recordPopupUrl();
      popup.on("framenavigated", recordPopupUrl);
      popup.on("domcontentloaded", recordPopupUrl);
    } catch {}
  });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const reqUrl = req.url();
    const requestOrigin = safeOrigin(reqUrl);
    if (requestOrigin !== null && requestOrigin !== daemonOrigin) {
      recordExternalRequest(externalRequests, {
        url: reqUrl,
        method: req.method(),
        resourceType: req.resourceType(),
        headers: req.headers(),
        postData: req.postData()
      }, daemonOrigin);
    }
    const rewrittenBlobUrl = rewriteLegacyAuditBlobUrl(reqUrl, daemonOrigin, canonicalSlug, routeSlug, sandboxApiSocket !== null ? "local" : "notary");
    if (rewrittenBlobUrl === null && !isAuditRequestAllowed(reqUrl, daemonOrigin, routeSlug)) {
      if (blockedRequests.length < MAX_LOGGED_BLOCKED_REQUESTS) {
        blockedRequests.push(reqUrl);
      }
      await route.abort("blockedbyclient");
      return;
    }
    if (sandboxApiSocket !== null && requestOrigin === daemonOrigin) {
      await fulfillLocalAuditRequest(route, sandboxApiSocket, rewrittenBlobUrl ?? reqUrl, auditSessionId, localRequests.signal, onTransportFailure);
      return;
    }
    if (notaryToken !== null && safeOrigin(reqUrl) === daemonOrigin) {
      const headers = {
        ...req.headers(),
        authorization: notaryToken
      };
      if (auditSessionId !== null) {
        headers["x-hatch-audit-session"] = auditSessionId;
      }
      const outboundUrl = rewrittenBlobUrl ?? reqUrl;
      const outboundPath = new URL(outboundUrl).pathname;
      if (outboundPath === `/spaces/v2/${routeSlug}/actions_stream`) {
        await route.continue({
          headers,
          ...rewrittenBlobUrl === null ? {} : { url: outboundUrl }
        });
        return;
      }
      try {
        const response = await route.fetch({
          headers,
          maxRedirects: 0,
          timeout: 0,
          ...rewrittenBlobUrl === null ? {} : { url: outboundUrl }
        });
        await route.fulfill({ response });
      } catch {
        await route.abort("failed").catch(() => {});
      }
      return;
    }
    await route.continue(rewrittenBlobUrl === null ? undefined : { url: rewrittenBlobUrl });
  });
  return daemonOrigin;
}
function logAuditEvent(event, fields = {}) {
  try {
    process.stderr.write(`[spaces-audit] ${event} ${JSON.stringify(fields)}
`);
  } catch {}
}
var navRetriesThisRun = 0;
function isTransientNavStatus(status) {
  return status !== null && (status >= 500 || status === 429);
}
function isTransientNavError(err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("net::err_aborted"))
    return false;
  return msg.includes("timeout") || msg.includes("net::err_") || msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("socket hang up");
}
async function readBodyText(page) {
  return (await page.evaluate(() => document.body?.innerText ?? "")).trim();
}
function scanTextIssues(bodyText) {
  const issues = [];
  if (bodyText.length === 0) {
    issues.push({ kind: "blank_region", selector: "body" });
  }
  if (/\b(loading|loading\u2026|loading\.\.\.|please wait)\b/i.test(bodyText) && bodyText.length < 80) {
    issues.push({ kind: "loading_stuck", text: bodyText });
  }
  return issues.slice(0, MAX_LOGGED_TEXT_ISSUES);
}
async function collectRawImages(page) {
  return await page.evaluate(() => Array.from(document.querySelectorAll("img")).map((img) => {
    const style = window.getComputedStyle(img);
    const rect = img.getBoundingClientRect();
    return {
      src: img.currentSrc || img.src,
      alt: img.alt ?? "",
      complete: img.complete,
      nw: img.naturalWidth,
      nh: img.naturalHeight,
      hidden: style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0
    };
  }));
}
async function settleForCapture(page) {
  const startedAt = Date.now();
  let network_idle = true;
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {
    network_idle = false;
  });
  const sdk = network_idle ? await pollSdkIdle(page, SETTLE_TIMEOUT_MS) : null;
  return {
    settled: network_idle && (sdk?.settled ?? true),
    settle_ms: Date.now() - startedAt,
    in_flight: sdk?.in_flight ?? null,
    network_idle
  };
}
async function navigateForCapture(page, url, onAttempt) {
  const attempt = async () => {
    onAttempt?.();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS
    });
    const settle = await settleForCapture(page);
    return { status: response ? response.status() : null, settle };
  };
  try {
    const first = await attempt();
    if (isTransientNavStatus(first.status)) {
      navRetriesThisRun += 1;
      logAuditEvent("nav_retry", { reason: `transient status ${first.status}`, url });
      const retried = await attempt().catch(() => first);
      logAuditEvent("nav_retry_result", { first: first.status, retried: retried.status });
      return retried;
    }
    return first;
  } catch (err) {
    if (!isTransientNavError(err))
      throw err;
    navRetriesThisRun += 1;
    logAuditEvent("nav_retry", {
      reason: err.message?.slice(0, 160),
      url
    });
    const retried = await attempt();
    logAuditEvent("nav_retry_result", { recovered: true, status: retried.status });
    return retried;
  }
}
async function navigateAndSettle(page, url, onAttempt) {
  return (await navigateForCapture(page, url, onAttempt)).status;
}
async function startProxyAuthRelay(upstreamProxyUrl, username, token, options) {
  const connectOnly = options?.connectOnly === true;
  const upstream = new URL(upstreamProxyUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`unsupported proxy protocol: ${upstream.protocol}`);
  }
  const upstreamIsHttps = upstream.protocol === "https:";
  const upstreamHost = upstream.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const upstreamPort = upstream.port.length > 0 ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;
  const upstreamRequest = upstreamIsHttps ? httpsRequest : httpRequest;
  const credential = "Basic " + Buffer.from(`${username}:${token}`).toString("base64");
  const server = createServer2((clientReq, clientRes) => {
    if (connectOnly) {
      try {
        clientRes.writeHead(405, { connection: "close" });
        clientRes.end();
      } catch {}
      return;
    }
    const upstreamReq = upstreamRequest({
      host: upstreamHost,
      port: upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers: { ...clientReq.headers, "proxy-authorization": credential }
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });
    upstreamReq.on("error", () => {
      try {
        clientRes.writeHead(502);
        clientRes.end();
      } catch {}
    });
    clientReq.pipe(upstreamReq);
  });
  const sockets = new Set;
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    const connectRequest = `CONNECT ${target} HTTP/1.1\r
Host: ${target}\r
Proxy-Authorization: ${credential}\r
\r
`;
    const upstreamSocket = upstreamIsHttps ? tlsConnect2({
      host: upstreamHost,
      port: upstreamPort,
      servername: isIP2(upstreamHost) ? undefined : upstreamHost
    }) : netConnect2(upstreamPort, upstreamHost);
    upstreamSocket.once(upstreamIsHttps ? "secureConnect" : "connect", () => {
      upstreamSocket.write(connectRequest);
    });
    sockets.add(clientSocket);
    sockets.add(upstreamSocket);
    const teardown = () => {
      sockets.delete(clientSocket);
      sockets.delete(upstreamSocket);
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
    upstreamSocket.on("close", teardown);
    clientSocket.pause();
    let established = false;
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      if (established) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf(`\r
\r
`);
      if (headerEnd === -1) {
        return;
      }
      established = true;
      upstreamSocket.removeListener("data", onData);
      const statusLine = buffer.subarray(0, buffer.indexOf(`\r
`)).toString("latin1");
      clientSocket.write(buffer);
      if (statusLine.split(/\s+/)[1] === "200") {
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      } else {
        clientSocket.end();
        upstreamSocket.end();
      }
    };
    upstreamSocket.on("data", onData);
    upstreamSocket.on("error", () => {
      if (!established) {
        try {
          clientSocket.end(`HTTP/1.1 502 Bad Gateway\r
\r
`);
        } catch {}
      }
      teardown();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    server: `http://[::1]:${port}`,
    close: () => new Promise((resolve) => {
      for (const socket of [...sockets]) {
        socket.destroy();
      }
      sockets.clear();
      server.close(() => resolve());
    })
  };
}
if (false) {}

// src/probe-ui-cli.ts
var SESSION_SCHEMA_VERSION = "hatch.probe_ui_session.v1";
var SOCKET_BASENAME = "sock";
var SESSION_BASENAME = "session.json";
var PROBE_DIR = join2(".harness", "probe-ui");
var IDLE_EXIT_MS = 300000;
var NETWORK_IDLE_FALLBACK_MS = 4000;
var OP_TIMEOUT_MS = 30000;
function frozenEpochMs(flags) {
  const raw = Number((flags.get("frozen-epoch-ms") ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now() + (SCENARIO_CLOCK_OFFSET_MS ?? 0);
}
var OPS = new Set(["observe", "act", "viewport", "flag", "status", "close", "batch", "reload", "key"]);
var MAX_BATCH_STEPS = 12;
var ACTIONS = new Set(["click", "fill", "press", "scroll", "select", "hover", "double_click"]);
function deviceContextOptions(device) {
  return device === "mobile" ? { viewport: { ...MOBILE_VIEWPORT }, isMobile: true, hasTouch: true } : { viewport: { ...DESKTOP_VIEWPORT } };
}
var DEVICE_SWITCH_NOTE = "the page reloaded as the other device: cookies and localStorage carried over, but state " + "held only in memory, such as an open tab or dialog, starts over";
function parseProbeArgv(argv) {
  const flags = new Map;
  let op = null;
  for (let i = 0;i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) {
      if (op === null)
        op = raw.trim();
      else if (!flags.has("_positional"))
        flags.set("_positional", raw.trim());
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      flags.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(raw.slice(2), next);
      i += 1;
    } else {
      flags.set(raw.slice(2), "true");
    }
  }
  return { op, flags };
}
var KNOWN_FLAGS = {
  observe: ["socket", "find"],
  act: ["socket", "node", "name", "snapshot", "action", "text", "key", "dy", "click", "double_click", "fill", "select", "hover", "press", "scroll"],
  viewport: ["socket", "preset", "_positional"],
  key: ["socket", "key", "_positional"],
  reload: ["socket"],
  flag: ["socket", "severity", "what"],
  status: ["socket"],
  close: ["socket"],
  batch: ["socket"]
};
function requestFromArgv(op, flags) {
  if (op !== null && KNOWN_FLAGS[op] !== undefined) {
    const allowed = new Set(KNOWN_FLAGS[op]);
    const unknown = [...flags.keys()].filter((f) => !allowed.has(f));
    if (unknown.length > 0) {
      const opFlag = unknown.find((u) => OPS.has(u));
      const idFlag = unknown.find((u) => /^(session|session_id|sessionid|window|tab)$/i.test(u));
      const hint = opFlag !== undefined ? ` \u2014 ${unknown.filter((u) => OPS.has(u)).join(", ")} is an op, not a flag: run it as \`probe-ui.js ${opFlag}\`` : idFlag !== undefined ? ` \u2014 the live session is addressed by --socket alone; there is no --${idFlag}. The session_id in the probe object is a record id, not a CLI argument.` : "";
      return `${op} does not accept --${unknown.join(", --")}${hint}`;
    }
  }
  if (op === null || !OPS.has(op)) {
    return `unknown op ${JSON.stringify(op)}; expected one of ${[...OPS].join(", ")}`;
  }
  if (op === "act") {
    const nodeRaw = flags.get("node");
    const node = nodeRaw === undefined ? Number.NaN : Number(nodeRaw);
    const name = (flags.get("name") ?? "").trim();
    const addressed = Number.isInteger(node) && node >= 1;
    if (!addressed && name.length === 0) {
      return 'act requires --node <n>, the number from the latest observe, or --name "<visible label>"';
    }
    const named = flags.get("action")?.trim();
    const action = named !== undefined ? [...ACTIONS].find((a) => a === named) : [...ACTIONS].find((a) => flags.has(a));
    if (action === undefined) {
      return `act requires one of --${[...ACTIONS].join(" --")}, or --action <one of them>`;
    }
    const req = addressed ? { op, node, action } : { op, name, action };
    const snapshot = flags.get("snapshot");
    if (snapshot !== undefined)
      req.snapshot_id = snapshot;
    const value = (flag) => {
      const own = flags.get(flag);
      return own !== undefined && own !== "true" ? own : undefined;
    };
    if (action === "fill")
      req.text = value("fill") ?? flags.get("text") ?? "";
    if (action === "select")
      req.text = value("select") ?? flags.get("text") ?? "";
    if (action === "press")
      req.key = value("press") ?? flags.get("key") ?? "Enter";
    if (action === "scroll")
      req.dy = Number(value("scroll") ?? flags.get("dy") ?? "400") || 400;
    return req;
  }
  if (op === "viewport") {
    const preset = (flags.get("preset") ?? flags.get("_positional") ?? "").trim();
    if (preset !== "desktop" && preset !== "mobile") {
      return "viewport requires desktop or mobile";
    }
    return { op, preset };
  }
  if (op === "key") {
    const key = (flags.get("key") ?? flags.get("_positional") ?? "").trim();
    if (key.length === 0)
      return "key requires a key name, e.g. key Escape";
    return { op, key };
  }
  if (op === "flag") {
    const what = (flags.get("what") ?? "").trim();
    if (what.length === 0)
      return 'flag requires --what "<what you saw>"';
    return { op, severity: (flags.get("severity") ?? "major").trim(), what };
  }
  if (op === "observe") {
    const find = (flags.get("find") ?? "").trim();
    return find.length > 0 ? { op, find } : { op };
  }
  return { op };
}
function newSnapshotId(state) {
  const id = `s${state.observes}-${Math.abs(hash32(`${state.auditSessionId}:${state.observes}:${state.acts}`)).toString(36)}`;
  state.snapshotId = id;
  return id;
}
function hash32(input) {
  let h = 2166136261;
  for (let i = 0;i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
async function captureFrame(state, auditDir, name) {
  if (auditDir === null)
    return { path: null, changed: null, hash: null };
  const path = join2(auditDir, name);
  try {
    await state.page.screenshot({ path, fullPage: false });
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    const changed = state.lastShotHash === null ? true : hash !== state.lastShotHash;
    state.lastShotHash = hash;
    return { path, changed, hash };
  } catch {
    return { path: null, changed: null, hash: null };
  }
}
function lookDirective(path, acted, sameAsSeen) {
  if (path === null)
    return;
  if (sameAsSeen) {
    return acted ? `THE PIXELS DID NOT CHANGE. Your action ran but this frame is byte-identical to ${sameAsSeen} \u2014 treat that as evidence the action had no visible effect, and check whether it was supposed to.` : `This frame is byte-identical to ${sameAsSeen}. If you already read ${sameAsSeen}, no need to re-read it; if you have not, READ ${path} now \u2014 the tree below cannot show layout, clipping, overlap, contrast or styling.`;
  }
  return acted ? `READ ${path} NOW with the read tool. You just changed the page; this is the frame you have to judge, and the tree below cannot show layout, clipping, overlap, contrast or styling. Do not report on this action without looking at it.` : `READ ${path} with the read tool before judging this frame. The tree below cannot show layout, clipping, overlap, contrast or styling.`;
}
function surfaceFrame(state, frame) {
  const sameAsSeen = frame.hash !== null && state.lastSurfacedShot !== null && state.lastSurfacedShot.hash === frame.hash ? state.lastSurfacedShot.path : null;
  if (frame.path !== null && frame.hash !== null) {
    state.lastSurfacedShot = { path: frame.path, hash: frame.hash };
  }
  return sameAsSeen;
}
function narrowToFind(frame, find) {
  const wanted = find.trim().toLowerCase();
  const all = frame.nodes ?? [];
  const matched = all.filter((n) => (n.name ?? "").toLowerCase().includes(wanted));
  const { aria: _aria, ...rest } = frame;
  return {
    ...rest,
    find,
    nodes: matched,
    nodes_matched: matched.length,
    nodes_total: all.length,
    aria_omitted: "observe without --find to get the accessibility tree",
    ...matched.length === 0 ? { hint: `no visible node's name contains ${JSON.stringify(find)} \u2014 observe without --find to see what is actually on the page` } : {}
  };
}
async function doObserve(state, auditDir, find) {
  const settle = await settlePage(state.page, NETWORK_IDLE_FALLBACK_MS);
  const walk = await observeNodes(state.page);
  const aria = await ariaSnapshot(state.page);
  state.observes += 1;
  state.interactiveNodesSeen = Math.max(state.interactiveNodesSeen, walk.interactive_nodes);
  const snapshotId = newSnapshotId(state);
  const frame = await captureFrame(state, auditDir, `observe-${String(state.observes).padStart(3, "0")}.png`);
  const screenshotPath = frame.path;
  const screenshotChanged = frame.changed;
  const sameAsSeen = surfaceFrame(state, frame);
  const images = await collectRawImages(state.page).then((raw) => summarizeImages(raw, state.failedImages, state.daemonOrigin, state.egressLockdown)).catch(() => null);
  const textIssues = await readBodyText(state.page).then(scanTextIssues).catch(() => []);
  const unnamed = unnamedInteractiveNodes(walk);
  const clipped = clippedNodes(walk);
  const consoleErrors = state.consoleErrors.splice(0, state.consoleErrors.length);
  const response = {
    ok: true,
    look_at_screenshot: lookDirective(screenshotPath, false, sameAsSeen),
    snapshot_id: snapshotId,
    viewport: state.viewport,
    settled: settle.settled,
    settle_ms: settle.settle_ms,
    ...settle.in_flight === null ? {} : { in_flight: settle.in_flight },
    nav_status: state.navStatus,
    screenshot_path: screenshotPath,
    screenshot_sha256: frame.hash,
    screenshot_changed: screenshotChanged,
    interactive_nodes: walk.interactive_nodes,
    nodes_truncated: walk.truncated,
    total_candidates: walk.total_candidates,
    console_errors: consoleErrors,
    external_fetch_failures: state.externalFetchFailures.count,
    images,
    text_issues: textIssues,
    unnamed_interactive: unnamed.map((n) => ({ i: n.i, tag: n.tag, bbox: n.bbox })),
    clipped_nodes: clipped,
    unreachable_controls: walk.unreachable,
    needs_inner_scroll: walk.needs_inner_scroll,
    note: settle.settled ? undefined : settle.in_flight === null ? `network still active after ${settle.settle_ms}ms (no SDK settle hook; network idle did not arrive inside the window); the artifact may not have finished loading` : `still fetching after ${settle.settle_ms}ms (${settle.in_flight} query/queries in flight); the artifact has not finished loading`,
    nodes: walk.nodes,
    aria
  };
  return find !== undefined && find.trim().length > 0 ? narrowToFind(response, find) : response;
}
async function resolveByName(state, name) {
  const walk = await observeNodes(state.page);
  const wanted = name.trim().toLowerCase();
  const exact = walk.nodes.filter((n) => n.name.trim().toLowerCase() === wanted);
  const hits = exact.length > 0 ? exact : walk.nodes.filter((n) => n.name.toLowerCase().includes(wanted));
  if (hits.length === 0) {
    return { error: `no visible node named ${JSON.stringify(name)}; observe to see what is there` };
  }
  if (hits.length > 1) {
    return {
      error: `${hits.length} visible nodes match ${JSON.stringify(name)} (${hits.map((h) => `${h.i}:${h.tag}`).join(", ")}); observe and act by node number instead`
    };
  }
  state.snapshotId = newSnapshotId(state);
  return { node: hits[0].i };
}
async function doBatch(state, auditDir, req) {
  const steps = req.steps ?? [];
  if (steps.length === 0) {
    return { ok: false, code: "empty_batch", error: "batch needs a non-empty steps array" };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    return {
      ok: false,
      code: "batch_too_long",
      error: `batch has ${steps.length} steps; the cap is ${MAX_BATCH_STEPS}`
    };
  }
  const log = [];
  let last = null;
  for (const [idx, raw] of steps.entries()) {
    if (raw.op === "batch") {
      log.push({ step: idx + 1, op: raw.op, ok: false, error: "a batch step cannot itself be a batch" });
      break;
    }
    if (raw.op === undefined || !OPS.has(raw.op)) {
      log.push({
        step: idx + 1,
        op: raw.op ?? null,
        ok: false,
        error: `${raw.op === undefined ? 'step has no "op" key' : `unknown op ${JSON.stringify(raw.op)}`}; ` + `each step is {"op": "observe"|"act"|"viewport"|"key"|"flag", ...}, e.g. ` + `{"op":"act","name":"Add habit","action":"click"} or ` + `{"op":"act","name":"Destination","action":"fill","text":"Kyoto"} or {"op":"observe"}`
      });
      break;
    }
    const step = { ...raw };
    if (step.op === "act" && step.name !== undefined && step.node === undefined) {
      const resolved = await resolveByName(state, step.name);
      if ("error" in resolved) {
        log.push({ step: idx + 1, op: "act", name: step.name, ok: false, error: resolved.error });
        break;
      }
      step.node = resolved.node;
      step.snapshot_id = state.snapshotId ?? undefined;
    }
    const res = await handle(state, auditDir, step);
    last = res;
    log.push({
      step: idx + 1,
      op: step.op,
      ...step.name !== undefined ? { name: step.name } : {},
      ...step.node !== undefined ? { node: step.node } : {},
      ok: res.ok === true,
      ...res.snapshot_id !== undefined ? { snapshot_id: res.snapshot_id } : {},
      ...res.screenshot_path !== undefined ? { screenshot_path: res.screenshot_path } : {},
      ...res.screenshot_sha256 !== undefined ? { screenshot_sha256: res.screenshot_sha256 } : {},
      ...res.screenshot_changed !== undefined ? { screenshot_changed: res.screenshot_changed } : {},
      ...res.error !== undefined ? { error: res.error } : {}
    });
    if (res.ok !== true)
      break;
  }
  const allOk = log.every((l) => l.ok === true);
  let finalState = null;
  if (last) {
    if ("aria" in last) {
      const { aria: _finalAria, ...rest } = last;
      finalState = { ...rest, aria_omitted: "observe to get the accessibility tree for the final frame" };
    } else {
      finalState = last;
    }
  }
  return {
    ok: allOk,
    look_at_screenshot: "READ each step's screenshot_path below whose screenshot_changed is true, with the " + "read tool, before judging what the batch did \u2014 the tree cannot show layout, " + "clipping, overlap, or contrast. The final frame's node list is in `final`; " + "observe again if you need an earlier step's nodes.",
    steps: log,
    stopped_early: !allOk,
    final: finalState
  };
}
async function doAct(state, req, auditDir) {
  if (state.snapshotId === null) {
    return { ok: false, code: "no_snapshot", error: "call observe before act" };
  }
  if (req.snapshot_id !== undefined && req.snapshot_id !== state.snapshotId) {
    return {
      ok: false,
      code: "stale_snapshot",
      error: `snapshot ${req.snapshot_id} is stale (current ${state.snapshotId}); observe again`
    };
  }
  const touch = state.phoneFirst && state.viewport === "mobile";
  if (touch && req.action === "hover") {
    return {
      ok: false,
      code: "no_hover_on_touch",
      error: "the mobile viewport is a touch phone, which cannot hover, so a control only a hover " + "reveals is out of a phone user's reach; run `viewport desktop` to check hover behavior"
    };
  }
  const locator = state.page.locator(`[${OBSERVE_ATTR}="${req.node}"]`);
  const count = await locator.count().catch(() => 0);
  if (count !== 1) {
    state.snapshotId = null;
    return {
      ok: false,
      code: "stale_node",
      error: `node ${req.node} resolved to ${count} elements; observe again`,
      acted: false
    };
  }
  let acted = false;
  let actionError = null;
  try {
    if (req.action === "click" && touch)
      await locator.tap({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "click")
      await locator.click({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "double_click")
      await locator.dblclick({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "hover")
      await locator.hover({ timeout: OP_TIMEOUT_MS });
    else if (req.action === "select") {
      await locator.selectOption(req.text ?? "", { timeout: OP_TIMEOUT_MS });
    } else if (req.action === "fill")
      await locator.fill(req.text ?? "", { timeout: OP_TIMEOUT_MS });
    else if (req.action === "press")
      await locator.press(req.key ?? "Enter", { timeout: OP_TIMEOUT_MS });
    else if (req.action === "scroll") {
      await locator.scrollIntoViewIfNeeded({ timeout: OP_TIMEOUT_MS });
      await state.page.mouse.wheel(0, req.dy ?? 400);
    }
    acted = true;
  } catch (err) {
    actionError = err.message?.split(`
`)[0] ?? String(err);
  }
  state.acts += 1;
  if (acted)
    state.actedOk += 1;
  const settle = await settlePage(state.page, NETWORK_IDLE_FALLBACK_MS);
  const aria = await ariaSnapshot(state.page);
  state.snapshotId = null;
  const consoleErrors = state.consoleErrors.splice(0, state.consoleErrors.length);
  const frame = await captureFrame(state, auditDir, `act-${String(state.acts).padStart(3, "0")}.png`);
  const sameAsSeen = surfaceFrame(state, frame);
  return {
    ok: acted,
    look_at_screenshot: lookDirective(frame.path, acted, sameAsSeen),
    acted,
    error: actionError ?? undefined,
    settled: settle.settled,
    settle_ms: settle.settle_ms,
    screenshot_path: frame.path,
    screenshot_sha256: frame.hash,
    screenshot_changed: frame.changed,
    console_errors: consoleErrors,
    external_fetch_failures: state.externalFetchFailures.count,
    next: acted ? "the post-action tree is below (`aria`), so you only need a fresh `observe` when you want node numbers to act on. Read the screenshot above before you judge what this action did. If you already know the next few steps, send them as one `batch` call instead of one call per step." : "observe to get a fresh node list",
    aria
  };
}
async function applyViewport(state, preset) {
  const isMobile = preset === "mobile";
  const viewport = isMobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
  await state.page.setViewportSize({ ...viewport });
  state.viewport = isMobile ? "mobile" : "desktop";
  state.viewportsSeen.add(state.viewport);
  state.snapshotId = null;
}
async function switchDevice(state, device) {
  if (device === state.viewport)
    return null;
  const entry = new URL(state.url);
  const current = new URL(state.page.url());
  const sameAddress = current.origin === entry.origin && current.pathname === entry.pathname;
  const target = sameAddress ? current.href : state.url;
  const next = await state.openDevice(device, await state.context.storageState());
  let navStatus;
  try {
    navStatus = await navigateAndSettle(next.page, target);
  } catch (err) {
    await next.context.close().catch(() => {});
    throw err;
  }
  const replaced = state.context;
  state.context = next.context;
  state.page = next.page;
  state.navStatus = navStatus;
  state.viewport = device;
  state.viewportsSeen.add(device);
  state.snapshotId = null;
  state.lastShotHash = null;
  state.lastSurfacedShot = null;
  await replaced.close().catch(() => {});
  return sameAddress ? "same address" : "start page";
}
async function handle(state, auditDir, req) {
  switch (req.op) {
    case "observe":
      return doObserve(state, auditDir, req.find);
    case "act": {
      if (req.name !== undefined && req.node === undefined) {
        const resolved = await resolveByName(state, req.name);
        if ("error" in resolved) {
          return { ok: false, code: "no_such_name", error: resolved.error };
        }
        req = { ...req, node: resolved.node };
      }
      return doAct(state, req, auditDir);
    }
    case "viewport": {
      if (!state.phoneFirst) {
        await applyViewport(state, req.preset ?? "desktop");
        return { ...await doObserve(state, auditDir), viewport_changed: state.viewport };
      }
      if (req.preset !== "desktop" && req.preset !== "mobile") {
        return {
          ok: false,
          code: "bad_viewport",
          error: `viewport takes a preset, not a size; this session is on ${state.viewport}. ` + `As a batch step, a phone (${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height}) is ` + '{"op":"viewport","preset":"mobile"} and desktop ' + `(${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height}) is ` + '{"op":"viewport","preset":"desktop"}'
        };
      }
      const reopened = await switchDevice(state, req.preset);
      return {
        ...await doObserve(state, auditDir),
        viewport_changed: state.viewport,
        ...reopened === null ? {} : { reopened, device_switch: DEVICE_SWITCH_NOTE }
      };
    }
    case "flag":
      state.findings.push({
        severity: req.severity ?? "major",
        what: req.what ?? "",
        viewport: state.viewport,
        at_ms: Date.now() + (SCENARIO_CLOCK_OFFSET_MS ?? 0)
      });
      return { ok: true, findings: state.findings.length };
    case "reload": {
      state.navStatus = await navigateAndSettle(state.page, state.url);
      state.snapshotId = null;
      state.lastShotHash = null;
      state.lastSurfacedShot = null;
      return { ...await doObserve(state, auditDir), reloaded: true };
    }
    case "key": {
      await state.page.keyboard.press(req.key ?? "Escape");
      return { ...await doObserve(state, auditDir), key: req.key ?? "Escape" };
    }
    case "batch":
      return doBatch(state, auditDir, req);
    case "status":
      return {
        ok: true,
        slug: state.slug,
        url: state.url,
        viewport: state.viewport,
        observes: state.observes,
        acts: state.acts,
        acts_ok: state.actedOk,
        interactive_nodes_seen: state.interactiveNodesSeen,
        findings: state.findings,
        snapshot_id: state.snapshotId
      };
    default:
      return { ok: false, code: "unknown_op", error: `unsupported op ${req.op}` };
  }
}
async function withOpTimeout(work) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      code: "op_timeout",
      error: `op exceeded ${OP_TIMEOUT_MS} ms; the page's main thread is likely blocked`
    }), OP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null)
      clearTimeout(timer);
  }
}
var PROBE_NETWORK_BASENAME = "probe-network.json";
async function writeProbeNetworkRecord(outputDir, ledger, externalRequests, url) {
  const explained = new Set;
  const probeDestination = ledgerDestinationKey(url);
  if (probeDestination !== null) {
    explained.add(probeDestination);
  }
  for (const request of externalRequests.requests) {
    const destination = ledgerDestinationKey(request.url);
    if (destination !== null) {
      explained.add(destination);
    }
  }
  await writeFile(join2(outputDir, PROBE_NETWORK_BASENAME), JSON.stringify({
    probe_transport_ledger_active: ledger !== null,
    external_requests: externalRequests.requests,
    external_requests_dropped: externalRequests.dropped,
    external_requests_dropped_data_bearing: externalRequests.dropped_data_bearing,
    transport_connections: ledger === null ? [] : [...ledger.state.entries.values()],
    transport_udp_attempts: ledger === null ? 0 : ledger.state.udp_attempts,
    transport_overflow: ledger === null ? 0 : ledger.state.overflow,
    unexplained_transport_hosts: ledger === null ? [] : unexplainedTransportHosts(ledger.state, explained)
  }, null, 2) + `
`);
}
async function writeSessionSummary(probeDir, state, sessionId) {
  await writeFile(join2(probeDir, "summary.json"), JSON.stringify({
    schema_version: "hatch.probe_ui_summary.v1",
    slug: state.slug,
    session_id: sessionId,
    observes: state.observes,
    acts: state.acts,
    acts_ok: state.actedOk,
    interactive_nodes: state.interactiveNodesSeen,
    viewports_seen: [...state.viewportsSeen].sort(),
    findings: state.findings
  }, null, 2) + `
`);
}
async function serve(flags) {
  const slug = (flags.get("slug") ?? "").trim();
  const routeSlug = (flags.get("route-slug") ?? "").trim();
  const url = (flags.get("url") ?? "").trim();
  const spaceDir = (flags.get("space-dir") ?? "").trim();
  const socketPath = (flags.get("socket") ?? "").trim() || (spaceDir ? join2(spaceDir, PROBE_DIR, SOCKET_BASENAME) : "");
  const auditSessionId = (flags.get("audit-session") ?? flags.get("session") ?? "").trim() || null;
  const auditDir = (flags.get("audit-dir") ?? "").trim() || null;
  const phoneFirst = flags.get("phone-first") === "true";
  const proxyServer = (flags.get("proxy-server") ?? "").trim() || null;
  const proxyAuthUsername = (flags.get("proxy-auth-username") ?? "").trim() || null;
  if (!slug || !routeSlug || !url || !socketPath) {
    process.stderr.write(`probe-ui serve: --slug, --route-slug, --url and (--socket or --space-dir) are required
`);
    return 2;
  }
  const { notaryToken, proxyAuthToken } = await readAuditTokensFromStdin();
  const probeDir = dirname2(socketPath);
  await mkdir(probeDir, { recursive: true });
  if (auditDir !== null)
    await mkdir(auditDir, { recursive: true });
  let effectiveProxy = proxyServer;
  let relayClose = null;
  if (proxyServer !== null && proxyAuthToken !== null) {
    const relay = await startProxyAuthRelay(proxyServer, proxyAuthUsername ?? "hatch-runtime", proxyAuthToken, { connectOnly: true });
    effectiveProxy = relay.server;
    relayClose = relay.close;
  }
  let transportLedger = null;
  if (effectiveProxy !== null) {
    try {
      const probeDestination = ledgerDestinationKey(url);
      if (probeDestination === null) {
        throw new Error(`probe url has no TCP destination: ${url}`);
      }
      transportLedger = await startTransportLedger(effectiveProxy, {
        allowedDestinations: new Set([probeDestination])
      });
      effectiveProxy = transportLedger.server;
    } catch (err) {
      process.stderr.write(`[probe-ui] transport ledger failed to start; continuing without egress lockdown: ${String(err)}
`);
      transportLedger = null;
      if (relayClose !== null && proxyServer !== null && proxyAuthToken !== null) {
        try {
          await relayClose();
        } catch {}
        const openRelay = await startProxyAuthRelay(proxyServer, proxyAuthUsername ?? "hatch-runtime", proxyAuthToken);
        effectiveProxy = openRelay.server;
        relayClose = openRelay.close;
      }
    }
  }
  let executablePath = findSystemChrome();
  if (executablePath === null) {
    await ensureChromium();
  }
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch(buildLaunchOptions(executablePath, effectiveProxy, null, proxyAuthUsername));
  const consoleErrors = [];
  const failedImages = [];
  const blockedRequests = [];
  const externalRequests = newExternalRequestLog();
  const egressLockdown = transportLedger !== null;
  const externalFetchFailures = { count: 0, samples: [] };
  const frozenEpoch = frozenEpochMs(flags);
  const sandboxApiSocket = (flags.get("sandbox-api-socket") ?? "").trim() || null;
  const openDevice = async (device, storageState) => {
    const context = await browser.newContext({
      ...deviceContextOptions(device),
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      ignoreHTTPSErrors: true,
      ...storageState === undefined ? {} : { storageState }
    });
    await context.addInitScript(freezeTimeScript(frozenEpoch));
    const page = await context.newPage();
    const daemonOrigin = await attachAuditNetworkPolicy(page, url, slug, routeSlug, notaryToken, auditSessionId, blockedRequests, externalRequests, sandboxApiSocket);
    installPageDiagnostics(page, consoleErrors, failedImages, daemonOrigin, [], [], externalFetchFailures, egressLockdown);
    return { context, page, daemonOrigin };
  };
  const startDevice = phoneFirst ? "mobile" : "desktop";
  const { context, page, daemonOrigin } = await openDevice(startDevice);
  const networkDir = auditDir ?? probeDir;
  const recordNetwork = () => writeProbeNetworkRecord(networkDir, transportLedger, externalRequests, url).catch(() => {});
  const state = {
    browser,
    context,
    page,
    url,
    slug,
    daemonOrigin,
    auditSessionId: auditSessionId ?? socketPath,
    viewport: startDevice,
    viewportsSeen: new Set([startDevice]),
    phoneFirst,
    openDevice,
    snapshotId: null,
    consoleErrors,
    failedImages,
    egressLockdown,
    externalFetchFailures,
    findings: [],
    navStatus: null,
    observes: 0,
    acts: 0,
    interactiveNodesSeen: 0,
    actedOk: 0,
    lastShotHash: null,
    lastSurfacedShot: null
  };
  await writeFile(join2(probeDir, SESSION_BASENAME), JSON.stringify({
    schema_version: SESSION_SCHEMA_VERSION,
    socket: socketPath,
    slug,
    url,
    audit_session_id: auditSessionId,
    pid: process.pid,
    ...phoneFirst ? { phone_first: true } : {}
  }, null, 2) + `
`);
  await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
  await recordNetwork();
  let pageNavigated = () => {};
  const pageReady = new Promise((resolve) => {
    pageNavigated = resolve;
  });
  let navFailedReason = null;
  let idleTimer = null;
  let closing = false;
  const shutdown = async (reason) => {
    if (closing)
      return;
    closing = true;
    if (idleTimer !== null)
      clearTimeout(idleTimer);
    process.stderr.write(`[probe-ui] shutting down: ${reason}
`);
    await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
    await recordNetwork();
    await state.context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (transportLedger !== null)
      await transportLedger.close().catch(() => {});
    if (relayClose !== null)
      await relayClose().catch(() => {});
    server.close();
    process.exit(0);
  };
  const touchIdle = () => {
    if (idleTimer !== null)
      clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown("idle"), IDLE_EXIT_MS);
  };
  const server = createServer3((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf(`
`);
      if (nl < 0)
        return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      touchIdle();
      (async () => {
        let response;
        try {
          const req = JSON.parse(line);
          if (!OPS.has(req.op)) {
            response = { ok: false, code: "unknown_op", error: `unsupported op ${req.op}` };
          } else if (req.op === "close") {
            response = { ok: true, closing: true };
          } else if (req.op === "status" || req.op === "flag") {
            response = await withOpTimeout(handle(state, auditDir, req));
          } else {
            await pageReady;
            if (navFailedReason !== null && req.op !== "reload") {
              response = {
                ok: false,
                code: "nav_failed",
                error: `the probe's startup navigation failed (${navFailedReason}); ` + "run `reload` to retry it, or re-run web_artifact_audit"
              };
            } else {
              response = await withOpTimeout(handle(state, auditDir, req));
              if (req.op === "reload" && response.ok === true) {
                navFailedReason = null;
              }
            }
          }
        } catch (err) {
          response = { ok: false, code: "op_failed", error: err.message };
        }
        await writeSessionSummary(probeDir, state, auditSessionId).catch(() => {});
        await recordNetwork();
        sock.end(JSON.stringify(response) + `
`);
        if (response.closing) {
          shutdown("client asked to close");
        }
      })();
    });
    sock.on("error", () => sock.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  touchIdle();
  process.stderr.write(`[probe-ui] listening on ${socketPath} slug=${slug} (navigation pending)
`);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => void shutdown(signal));
  }
  const navStarted = Date.now();
  try {
    state.navStatus = await navigateAndSettle(page, url);
    process.stderr.write(`[probe-ui] navigated slug=${slug} nav_status=${state.navStatus} nav_ms=${Date.now() - navStarted}
`);
  } catch (err) {
    navFailedReason = err.message?.split(`
`)[0] ?? String(err);
    process.stderr.write(`[probe-ui] startup navigation failed: ${navFailedReason}
`);
  }
  pageNavigated();
  await new Promise(() => {});
  return 0;
}
async function runClient(socketPath, req) {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    let buf = "";
    const fail = (msg) => {
      process.stderr.write(`probe-ui: ${msg}
` + `  The session is opened by web_artifact_audit; run it first (or again).
`);
      resolve(1);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + `
`));
    sock.on("data", (chunk) => {
      buf += chunk;
      if (!buf.includes(`
`))
        return;
      process.stdout.write(buf.slice(0, buf.indexOf(`
`)) + `
`);
      sock.end();
      resolve(0);
    });
    sock.on("error", (err) => fail(`cannot reach the probe session (${err.message})`));
    sock.on("close", () => {
      if (buf.length === 0)
        fail("probe session closed without answering");
    });
  });
}
async function discoverSocket() {
  const envSocket = (process.env.HATCH_PROBE_UI_SOCKET ?? "").trim();
  if (envSocket.length > 0)
    return envSocket;
  const roots = [
    join2(homedir(), "workspace", "ts-spaces"),
    join2(process.cwd(), "..", "..", "ts-spaces")
  ];
  let newest = null;
  for (const root of roots) {
    let slugs;
    try {
      slugs = await readdir(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const candidate = join2(root, slug, PROBE_DIR, SOCKET_BASENAME);
      try {
        const info = await stat(candidate);
        if (newest === null || info.mtimeMs > newest.mtimeMs) {
          newest = { path: candidate, mtimeMs: info.mtimeMs };
        }
      } catch {}
    }
    if (newest !== null)
      break;
  }
  if (newest !== null)
    return newest.path;
  const local = join2(process.cwd(), PROBE_DIR, SOCKET_BASENAME);
  try {
    await stat(local);
    return local;
  } catch {
    return null;
  }
}
var USAGE = `usage: bun probe-ui.js <op> [flags]

  observe                          look at the artifact: screenshot + visible
                                   accessibility tree + numbered nodes
  observe --find "<text>"          just the nodes whose name contains <text>
                                   (numbers stay valid for act; no aria tree) \u2014
                                   use this instead of piping observe through
                                   head/tail/jq to find one control
  act --node <n> --click           click the node numbered by the last observe
  act --node <n> --fill "<text>"   type into it
  act --node <n> --press <Key>     press a key against it
  act --node <n> --scroll <dy>     scroll it into view and wheel
  act --node <n> --select "<opt>"   choose an option in a <select>
  act --node <n> --hover           hover it (reveals hover-only controls)
  act --node <n> --double_click    double-click it
  act --name "<label>" --action click   the batch step's spelling, one step
  key <Key>                        send a key to the page, not a node (Escape, Tab)
  reload                           re-navigate to pick up a rebuild, then observe
  viewport desktop|mobile          switch viewport (spends the node list)
  flag --severity <s> --what "\u2026"   record a finding
  status                           session counters and findings
  batch  (steps on stdin)          run several ops in ONE call \u2014 the way to keep a
                                   multi-step flow to a single turn. Address by
                                   "name" and each step re-resolves against the
                                   live page; an ambiguous name stops the batch
                                   instead of guessing:
                                     bun probe-ui.js batch <<'JSON'
                                     [{"op":"act","name":"New habit name","action":"fill","text":"Walk"},
                                      {"op":"act","name":"Add habit","action":"click"},
                                      {"op":"observe"}]
                                     JSON

  --socket <path>   override the socket (default: the newest live session under
                    ~/workspace/ts-spaces/*/.harness/probe-ui/sock)

The harness owns settling \u2014 never write a wait or a timeout. Node numbers come
from the latest observe; if the page moved, observe again.
`;
var PHONE_FIRST_USAGE = USAGE.replace(`  act --node <n> --click           click the node numbered by the last observe
`, `  act --node <n> --click           click the node numbered by the last observe
` + `                                   (a tap on mobile)
`).replace(`  act --node <n> --hover           hover it (reveals hover-only controls)
`, `  act --node <n> --hover           hover it (desktop only: a phone cannot hover)
`).replace(`  viewport desktop|mobile          switch viewport (spends the node list)
`, `  viewport desktop|mobile          the session starts as a touch phone (mobile);
` + `                                   switching reloads the page as the other device,
` + `                                   keeping cookies, localStorage, and the URL's
` + `                                   query and fragment, so a tab or dialog held only
` + `                                   in memory starts over; reopened says whether the
` + `                                   same address or the start page loaded (a screen
` + `                                   on its own path reopens at the start page);
` + `                                   spends the node list
`);
async function usageFor(flags) {
  const socket = (flags.get("socket") ?? "").trim() || await discoverSocket();
  if (socket === null)
    return USAGE;
  let raw;
  try {
    raw = await readFile(join2(dirname2(socket), SESSION_BASENAME), "utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return USAGE;
    throw err;
  }
  return JSON.parse(raw).phone_first === true ? PHONE_FIRST_USAGE : USAGE;
}
async function readStdin() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin)
    buf += chunk;
  return buf;
}
async function main(argv) {
  const { op, flags } = parseProbeArgv(argv);
  if (op === "serve")
    return serve(flags);
  if (op === "batch") {
    const raw = (await readStdin()).trim();
    if (raw.length === 0) {
      process.stderr.write(`probe-ui batch: pipe a JSON array of steps on stdin, e.g.
` + `  bun probe-ui.js batch <<'JSON'
` + `  [{"op":"act","name":"New habit name","action":"fill","text":"Walk"},
` + `   {"op":"act","name":"Add habit","action":"click"},
` + `   {"op":"observe"}]
` + `  JSON
`);
      return 2;
    }
    let steps;
    try {
      const parsed = JSON.parse(raw);
      steps = Array.isArray(parsed) ? parsed : parsed.steps ?? [];
    } catch (err) {
      process.stderr.write(`probe-ui batch: steps are not valid JSON (${err.message})
`);
      return 2;
    }
    const socket = (flags.get("socket") ?? "").trim() || await discoverSocket();
    if (socket === null) {
      process.stderr.write(`probe-ui: no probe session found; web_artifact_audit opens one
`);
      return 1;
    }
    return runClient(socket, { op: "batch", steps });
  }
  if (op === null || op === "help" || flags.has("help")) {
    process.stdout.write(await usageFor(flags));
    return op === null ? 2 : 0;
  }
  const req = requestFromArgv(op, flags);
  if (typeof req === "string") {
    process.stderr.write(`probe-ui: ${req}

${await usageFor(flags)}`);
    return 2;
  }
  const socketPath = (flags.get("socket") ?? "").trim() || await discoverSocket();
  if (socketPath === null) {
    process.stderr.write("probe-ui: no probe session found. `web_artifact_audit` opens one and returns its\n" + "  socket path in the response's `probe` object; run the audit first, or pass\n" + `  --socket <path> explicitly.
`);
    return 1;
  }
  return runClient(socketPath, req);
}
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`probe-ui fatal: ${msg}
`);
    process.exit(2);
  });
}
export {
  PROBE_DIR,
  hash32,
  lookDirective,
  narrowToFind,
  parseProbeArgv,
  requestFromArgv
};
