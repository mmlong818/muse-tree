// @bun
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
import { mkdir, writeFile } from "fs/promises";
import { accessSync, constants as fsConstants, existsSync } from "fs";
import { createHash } from "crypto";
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
var SETTLE_POLL_INTERVAL_MS = 100;
var SETTLE_STABLE_POLLS = 2;
var MAX_OBSERVE_NODES = 120;
var MAX_CLIP_SCAN = 4000;
var CLIP_MIN_PX = 3;
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
var SCENARIO_CLOCK_OFFSET_MS = (() => {
  const raw = Number((process.env.HATCH_SPACES_PAGE_EPOCH_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw - Date.now() : null;
})();
function shiftTimeScript(offsetMs) {
  return `(() => {
  const OFFSET = ${offsetMs};
  const RealDate = Date;
  const now = () => RealDate.now() + OFFSET;
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = now;
  ShiftedDate.parse = RealDate.parse;
  ShiftedDate.UTC = RealDate.UTC;
  Object.defineProperty(ShiftedDate, "name", { value: "Date" });
  globalThis.Date = ShiftedDate;
})()`;
}
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

// src/playwright-audit.ts
var PLAYWRIGHT_DIRNAME = "playwright";
var DESKTOP_VIEWPORT = { width: 1440, height: 900 };
var MOBILE_VIEWPORT = { width: 390, height: 844 };
var PAGE_LOAD_TIMEOUT_MS = 15000;
var SETTLE_TIMEOUT_MS = 4000;
var TRANSITION_DOUBLE_TAKE_MS = 800;
function confirmTransientUnreachable(first, second) {
  const key = (u) => `${u.reason} ${u.name}`;
  const confirmed = new Set(second.map(key));
  return first.filter((u) => confirmed.has(key(u)));
}
var MOBILE_OVERFLOW_TOLERANCE_PX = 2;
var SYSTEM_CHROME_PATHS = [
  ...process.platform === "linux" && process.arch === "x64" ? ["/opt/hatch/assets/artifacts/headless-shell/chrome-headless-shell"] : [],
  "/opt/meta-chromium/chrome"
];
var SCREENSHOT_FILENAME = "screenshot.png";
var MOBILE_SCREENSHOT_FILENAME = "screenshot-mobile.png";
var FULLPAGE_SCREENSHOT_FILENAME = "screenshot-full.png";
var CAPTURE_MODE_FULL = "full";
var CAPTURE_MODE_DESKTOP_ONLY = "desktop-only";
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
function classifyMobileOverflow(viewportWidth, scrollWidth, widestSelector) {
  const overflowPx = Math.max(0, Math.round(scrollWidth - viewportWidth));
  const overflows = overflowPx > MOBILE_OVERFLOW_TOLERANCE_PX;
  return {
    viewport_width: Math.round(viewportWidth),
    scroll_width: Math.round(scrollWidth),
    overflow_px: overflowPx,
    widest_selector: overflows ? widestSelector : null,
    verdict: overflows ? "fail" : "pass"
  };
}
var HORIZONTAL_SCROLLER_SLACK_PX = 8;
var HORIZONTAL_SCROLLER_MIN_CLIENT_WIDTH_PX = 80;
var MAX_HORIZONTAL_SCROLLERS = 10;
function classifyHorizontalScrollers(candidates) {
  const out = [];
  for (const candidate of candidates) {
    if (!candidate.visible)
      continue;
    const clientWidth = Math.round(candidate.client_width);
    const scrollWidth = Math.round(candidate.scroll_width);
    if (clientWidth < HORIZONTAL_SCROLLER_MIN_CLIENT_WIDTH_PX)
      continue;
    if (scrollWidth <= clientWidth + HORIZONTAL_SCROLLER_SLACK_PX)
      continue;
    out.push({
      selector: candidate.selector,
      scroll_width: scrollWidth,
      client_width: clientWidth
    });
    if (out.length >= MAX_HORIZONTAL_SCROLLERS)
      break;
  }
  return out;
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
var MAX_ARIA_SNAPSHOT_CHARS = 20000;
function capAriaSnapshot(snapshot) {
  if (snapshot === null || snapshot.length <= MAX_ARIA_SNAPSHOT_CHARS) {
    return snapshot;
  }
  return `${snapshot.slice(0, MAX_ARIA_SNAPSHOT_CHARS)}
\u2026 (aria snapshot truncated at ${MAX_ARIA_SNAPSHOT_CHARS} chars)`;
}
var DOCUMENT_TEXT_FILENAME = "document-text.txt";
var MAX_DOCUMENT_TEXT_CHARS = 120000;
async function extractDocumentText(page) {
  return page.evaluate((maxChars) => {
    const SKIP = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "TEMPLATE",
      "SVG",
      "CANVAS",
      "VIDEO",
      "AUDIO",
      "IFRAME",
      "OBJECT",
      "EMBED",
      "HEAD",
      "LINK",
      "META"
    ]);
    const INLINE_DISPLAY = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "contents"]);
    const lines = [];
    let total = 0;
    let truncated = false;
    let inline = [];
    let prefix = "";
    let hiddenRun = false;
    const emit = (line, hidden) => {
      const text = line.replace(/[\s\u00a0]+/g, " ").trim();
      if (!text)
        return;
      const full = (hidden ? "[hidden] " : "") + text;
      if (total + full.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      lines.push(full);
      total += full.length + 1;
    };
    const flush = () => {
      if (inline.length)
        emit(prefix + inline.join(""), hiddenRun);
      inline = [];
      prefix = "";
    };
    const isHidden = (el) => {
      if (el.hidden || el.getAttribute("aria-hidden") === "true")
        return true;
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden";
    };
    const compact = (text) => (text || "").replace(/[\s\u00a0]+/g, " ").trim();
    const walk = (node, hidden) => {
      if (truncated)
        return;
      if (node.nodeType === Node.TEXT_NODE) {
        inline.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE)
        return;
      const el = node;
      const tag = el.tagName;
      if (SKIP.has(tag))
        return;
      const hiddenHere = hidden || isHidden(el);
      if (tag === "IMG") {
        inline.push(` [image: ${compact(el.getAttribute("alt")) || "no alt text"}] `);
        return;
      }
      if (tag === "BR") {
        inline.push(" ");
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        flush();
        const input = el;
        const label = compact(input.getAttribute("aria-label") || input.getAttribute("placeholder") || input.getAttribute("name"));
        let value = "";
        if (tag === "SELECT") {
          value = Array.from(el.options).map((option) => option.selected ? `${compact(option.text)}*` : compact(option.text)).join(" | ");
        } else if (input.type !== "password") {
          value = compact(input.value);
        }
        const kind = tag === "INPUT" ? `input ${input.type}` : tag.toLowerCase();
        emit(`[${kind}: ${label}${value ? ` = ${value}` : ""}]`, hiddenHere);
        return;
      }
      if (tag === "HR") {
        flush();
        emit("---", hiddenHere);
        return;
      }
      if (tag === "TR") {
        flush();
        const cells = Array.from(el.children).map((cell) => compact(cell.textContent));
        emit(cells.join(" | "), hiddenHere);
        return;
      }
      if (tag === "A") {
        for (const child of Array.from(el.childNodes))
          walk(child, hiddenHere);
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
          inline.push(` (\u2192 ${href})`);
        }
        return;
      }
      if (tag === "BUTTON") {
        inline.push(" [button: ");
        for (const child of Array.from(el.childNodes))
          walk(child, hiddenHere);
        inline.push("] ");
        return;
      }
      const heading = /^H([1-6])$/.exec(tag);
      const display = getComputedStyle(el).display;
      const block = heading !== null || tag === "LI" || !INLINE_DISPLAY.has(display);
      if (!block) {
        for (const child of Array.from(el.childNodes))
          walk(child, hiddenHere);
        return;
      }
      flush();
      hiddenRun = hiddenHere;
      if (heading)
        prefix = `${"#".repeat(Number(heading[1]))} `;
      else if (tag === "LI")
        prefix = "- ";
      const blockPrefix = prefix;
      for (const child of Array.from(el.childNodes)) {
        walk(child, hiddenHere);
        if (!inline.length)
          prefix = blockPrefix;
      }
      flush();
      hiddenRun = hidden;
    };
    walk(document.body, false);
    flush();
    return { text: lines.join(`
`), truncated };
  }, MAX_DOCUMENT_TEXT_CHARS);
}
function dedupeBrokenAssets(assets) {
  const seen = new Set;
  const out = [];
  for (const asset of assets) {
    const key = `${asset.url} ${asset.status}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
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
function parseArgs(argv) {
  const args = new Map;
  let skipInstall = false;
  let egressLockdown = false;
  for (const raw of argv) {
    if (raw === "--skip-install") {
      skipInstall = true;
      continue;
    }
    if (raw === "--egress-lockdown") {
      egressLockdown = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq < 0 || !raw.startsWith("--"))
      continue;
    args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  const slug = args.get("slug")?.trim();
  const routeSlug = args.get("route-slug")?.trim();
  const spaceDir = args.get("space-dir")?.trim();
  const url = args.get("url")?.trim();
  if (!slug || !routeSlug || !spaceDir || !url) {
    throw new Error("playwright-audit: --slug, --route-slug, --space-dir, and --url are required");
  }
  const outputDir = args.get("output-dir")?.trim() || join(spaceDir, ".space-build", PLAYWRIGHT_DIRNAME);
  const proxyRaw = args.get("proxy-server")?.trim();
  const proxyServer = proxyRaw && proxyRaw.length > 0 ? proxyRaw : null;
  const sessionRaw = args.get("audit-session")?.trim();
  const auditSessionId = sessionRaw && sessionRaw.length > 0 ? sessionRaw : null;
  const proxyAuthUserRaw = args.get("proxy-auth-username")?.trim();
  const proxyAuthUsername = proxyAuthUserRaw && proxyAuthUserRaw.length > 0 ? proxyAuthUserRaw : null;
  const captureMode = parseCaptureMode(args.get("capture"));
  return {
    slug,
    routeSlug,
    spaceDir,
    sandboxApiSocket: args.get("sandbox-api-socket")?.trim() || null,
    outputDir,
    url,
    skipInstall,
    captureMode,
    notaryToken: null,
    auditSessionId,
    proxyServer,
    proxyAuthToken: null,
    proxyAuthUsername,
    transport: null,
    egressLockdown
  };
}
function parseCaptureMode(rawValue) {
  const raw = rawValue?.trim();
  if (!raw || raw === CAPTURE_MODE_FULL) {
    return CAPTURE_MODE_FULL;
  }
  if (raw === CAPTURE_MODE_DESKTOP_ONLY) {
    return CAPTURE_MODE_DESKTOP_ONLY;
  }
  throw new Error(`playwright-audit: --capture must be ${CAPTURE_MODE_FULL} or ${CAPTURE_MODE_DESKTOP_ONLY}`);
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
async function detectBlockedAffordances(page) {
  try {
    const raw = await page.evaluate(() => {
      const out = [];
      const seen = new Set;
      const add = (kind, detail) => {
        const key = kind + "|" + detail;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ kind, detail });
        }
      };
      let inline = "";
      for (const s of Array.from(document.querySelectorAll("script:not([src])"))) {
        inline += `
` + (s.textContent || "");
      }
      if (/\bwindow\.print\s*\(|[^.\w]print\s*\(\s*\)/.test(inline))
        add("print", "window.print() in page script");
      if (/\b(alert|confirm|prompt)\s*\(/.test(inline))
        add("dialog", "alert()/confirm()/prompt() in page script");
      if (/navigator\.share\s*\(|navigator\.clipboard/.test(inline) && /location\.(href|origin)|document\.URL/.test(inline))
        add("self_url_share", "copies the page's own URL (location.href) in page script");
      const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'));
      for (const el of controls) {
        const label = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\s+/g, " ").trim().toLowerCase();
        if (!label)
          continue;
        const short = label.slice(0, 40);
        if (/\bprint\b|save as pdf/.test(label))
          add("print", `control labeled "${short}"`);
        else if (/share this page|copy link|copy url|share link/.test(label))
          add("self_url_share", `control labeled "${short}"`);
      }
      return out;
    });
    return raw.map((a) => ({ kind: a.kind, detail: a.detail }));
  } catch {
    return [];
  }
}
function emptyReport(args) {
  return {
    ok: true,
    url: args.url,
    duration_ms: 0,
    output_dir: args.outputDir,
    nav_status: null,
    viewports: {
      desktop: { ...DESKTOP_VIEWPORT, screenshot_path: null, fullpage_screenshot_path: null },
      mobile: { ...MOBILE_VIEWPORT, screenshot_path: null }
    },
    mobile_layout: null,
    horizontal_scrollers: [],
    unreachable_controls: { desktop: [], mobile: [] },
    clipped: { desktop: [], mobile: [] },
    images: {
      total: 0,
      broken: [],
      duplicate: [],
      unstable: [],
      failed_requests: [],
      external_blocked: { count: 0, sample: [] },
      sample_urls: [],
      verdict: "pass"
    },
    text_issues: [],
    console_errors: [],
    console_warnings: [],
    external_fetch_failures: 0,
    external_fetch_failure_samples: [],
    blocked_requests: [],
    external_requests: [],
    external_requests_dropped: 0,
    external_requests_dropped_data_bearing: 0,
    transport_ledger_active: false,
    egress_lockdown: args.egressLockdown,
    transport_connections: [],
    transport_udp_attempts: 0,
    transport_overflow: 0,
    unexplained_transport_hosts: [],
    broken_assets: [],
    blocked_affordances: [],
    interactive_nodes: 0,
    aria_snapshot: null,
    document_text: null,
    audit_session_id: args.auditSessionId,
    readiness: { desktop: null, mobile: null },
    color_scheme: null
  };
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
var COLOR_SCHEME_DECLARED_CHARS = 64;
var COLOR_SCHEME_SCRIPT = `(() => {
  const computed = (getComputedStyle(document.documentElement).colorScheme || "normal").trim();
  if (computed !== "normal") return computed;
  const content = document.querySelector('meta[name="color-scheme"]')?.getAttribute("content");
  return content && content.trim() ? content.trim().split(/\\s+/).join(" ") : computed;
})()`;
var DARK_SCREENSHOT_FILENAME = "screenshot-dark.png";
async function probeColorScheme(page, outputDir, settleAgain) {
  let declared = null;
  try {
    const value = await page.evaluate(COLOR_SCHEME_SCRIPT);
    declared = typeof value === "string" ? value.slice(0, COLOR_SCHEME_DECLARED_CHARS) : null;
  } catch {}
  const record = { declared, media_dependent: null, dark_frame: false };
  if (declared !== "dark" || outputDir === null)
    return record;
  const fold = () => page.screenshot({ fullPage: false, animations: "disabled" }).catch(() => null);
  const same = (a, b) => !!a && !!b && a.equals(b);
  const light = await fold();
  await settleAgain();
  if (!same(light, await fold()))
    return record;
  let dark = null;
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await settleAgain();
    dark = await fold();
  } catch {} finally {
    await page.emulateMedia({ colorScheme: null }).catch(() => {});
    await settleAgain();
  }
  if (!dark)
    return record;
  if (same(light, dark)) {
    record.media_dependent = false;
    return record;
  }
  if (!same(light, await fold()))
    return record;
  record.media_dependent = true;
  record.dark_frame = await writeFile(join(outputDir, DARK_SCREENSHOT_FILENAME), dark).then(() => true, () => false);
  return record;
}
var MOBILE_OVERFLOW_PROBE_TIMEOUT_MS = 5000;
async function withOverflowProbeTimeout(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("mobile overflow probe timed out")), MOBILE_OVERFLOW_PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
async function evaluateMobileOverflow(page) {
  try {
    const raw = await withOverflowProbeTimeout(page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollingEl = document.scrollingElement ?? doc;
      const viewportWidth = window.innerWidth || (doc ? doc.clientWidth : 0) || 0;
      const scrollWidth = Math.max(scrollingEl ? scrollingEl.scrollWidth : 0, doc ? doc.scrollWidth : 0, body ? body.scrollWidth : 0);
      let widestSelector = null;
      let widestRight = viewportWidth;
      const nodes = body ? body.querySelectorAll("*") : [];
      const MAX_SCAN = 4000;
      let scanned = 0;
      for (const el of Array.from(nodes)) {
        if (scanned >= MAX_SCAN)
          break;
        scanned += 1;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
          continue;
        if (rect.right > widestRight + 1) {
          widestRight = rect.right;
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : "";
          const className = typeof el.className === "string" ? el.className.trim() : "";
          const cls = className.length > 0 ? "." + className.split(/\s+/).slice(0, 2).join(".") : "";
          widestSelector = `${tag}${id}${cls}`.slice(0, 120);
        }
      }
      return { viewportWidth, scrollWidth, widestSelector, scanned };
    }));
    return classifyMobileOverflow(raw.viewportWidth, raw.scrollWidth, raw.widestSelector);
  } catch {
    return classifyMobileOverflow(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.width, null);
  }
}
async function evaluateHorizontalScrollers(page) {
  try {
    const raw = await withOverflowProbeTimeout(page.evaluate(() => {
      const out = [];
      const body = document.body;
      if (!body)
        return out;
      const segment = (el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const className = typeof el.className === "string" ? el.className.trim() : "";
        const cls = className.length > 0 ? "." + className.split(/\s+/).slice(0, 2).join(".") : "";
        return `${tag}${id}${cls}`;
      };
      const shortPath = (el) => {
        const parts = [segment(el)];
        let cursor = el.parentElement;
        while (cursor !== null && cursor !== body && parts.length < 3 && !parts.some((part) => part.includes("#"))) {
          parts.unshift(segment(cursor));
          cursor = cursor.parentElement;
        }
        return parts.join(" > ").slice(0, 160);
      };
      const MAX_SCAN = 4000;
      let scanned = 0;
      for (const el of Array.from(body.querySelectorAll("*"))) {
        if (scanned >= MAX_SCAN)
          break;
        scanned += 1;
        const style = window.getComputedStyle(el);
        const overflowX = style.overflowX;
        if (overflowX !== "auto" && overflowX !== "scroll")
          continue;
        const scrollWidth = el.scrollWidth;
        const clientWidth = el.clientWidth;
        if (scrollWidth <= clientWidth)
          continue;
        const rect = el.getBoundingClientRect();
        out.push({
          selector: shortPath(el),
          scroll_width: scrollWidth,
          client_width: clientWidth,
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
        });
        if (out.length >= 50)
          break;
      }
      return out;
    }));
    return classifyHorizontalScrollers(raw);
  } catch {
    return [];
  }
}

class AuditNavigationError extends Error {
  status;
  error_kind;
  constructor(status, error_kind) {
    super(error_kind === "capture_transport" ? "Artifact capture local transport failed" : `Artifact render failed with HTTP status ${status ?? "missing"}`);
    this.status = status;
    this.error_kind = error_kind;
  }
}
async function captureViewport(pw, url, canonicalSlug, routeSlug, viewport, outputDir, fileName, consoleErrors, consoleWarnings, blockedRequests, externalRequests, brokenAssets, externalFetchFailures, isMobile, executablePath, notaryToken, auditSessionId, proxyServer, proxyAuthToken, proxyAuthUsername, egressLockdown, sharedBrowser = null, sandboxApiSocket = null) {
  let browser;
  let ownsBrowser = false;
  let launch_ms = 0;
  let captureTransportFailed = false;
  if (sharedBrowser) {
    browser = sharedBrowser;
  } else {
    const launchStartedAt = performance.now();
    browser = await pw.chromium.launch(buildLaunchOptions(executablePath, proxyServer, proxyAuthToken, proxyAuthUsername));
    launch_ms = performance.now() - launchStartedAt;
    ownsBrowser = true;
  }
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: isMobile ? 3 : 1,
      hasTouch: isMobile,
      isMobile,
      serviceWorkers: "block",
      ignoreHTTPSErrors: true
    });
    if (SCENARIO_CLOCK_OFFSET_MS !== null) {
      await context.addInitScript(shiftTimeScript(SCENARIO_CLOCK_OFFSET_MS));
    }
    const page = await context.newPage();
    const daemonOrigin = new URL(url).origin;
    const failedImageResponses = [];
    installPageDiagnostics(page, consoleErrors, failedImageResponses, daemonOrigin, consoleWarnings, brokenAssets, externalFetchFailures, egressLockdown);
    await attachAuditNetworkPolicy(page, url, canonicalSlug, routeSlug, notaryToken, auditSessionId, blockedRequests, externalRequests, sandboxApiSocket, () => {
      captureTransportFailed = true;
    });
    let priorAttemptTransportFailed = false;
    const navigation = await navigateForCapture(page, url, () => {
      priorAttemptTransportFailed ||= captureTransportFailed;
      captureTransportFailed = false;
    }).catch((error) => {
      if (priorAttemptTransportFailed || captureTransportFailed) {
        throw new AuditNavigationError(null, "capture_transport");
      }
      throw error;
    });
    const navStatus = navigation.status;
    if (navStatus === null || navStatus < 200 || navStatus >= 300) {
      throw new AuditNavigationError(navStatus);
    }
    let settle = navigation.settle;
    const settleAgain = async () => {
      const again = await settleForCapture(page);
      settle = { ...again, settle_ms: settle.settle_ms + again.settle_ms };
    };
    const retried = !settle.settled;
    if (retried)
      await settleAgain();
    const color_scheme = await probeColorScheme(page, isMobile ? null : outputDir, settleAgain);
    const readiness = { ...settle, retried };
    const text_issues = scanTextIssues(await readBodyText(page));
    const rawImages = await collectRawImages(page);
    const images = summarizeImages(rawImages, failedImageResponses, daemonOrigin, egressLockdown);
    const mobile_layout = isMobile ? await evaluateMobileOverflow(page) : null;
    const horizontal_scrollers = isMobile ? await evaluateHorizontalScrollers(page) : [];
    let interactive_nodes = 0;
    let clipped = [];
    let unreachable_controls = await observeNodes(page).then((walk) => {
      interactive_nodes = walk.interactive_nodes;
      clipped = clippedNodes(walk);
      return walk.unreachable;
    }).catch(() => []);
    if (unreachable_controls.length > 0) {
      try {
        await page.waitForTimeout(TRANSITION_DOUBLE_TAKE_MS);
        const second = await observeNodes(page);
        unreachable_controls = confirmTransientUnreachable(unreachable_controls, second.unreachable);
        clipped = clippedNodes(second);
      } catch {}
    }
    const screenshotPath = join(outputDir, fileName);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    let fullpage_screenshot_path = null;
    let aria_snapshot = null;
    let document_text = null;
    let blocked_affordances = [];
    if (!isMobile) {
      const fullPagePath = join(outputDir, FULLPAGE_SCREENSHOT_FILENAME);
      try {
        await page.screenshot({ path: fullPagePath, fullPage: true });
        fullpage_screenshot_path = fullPagePath;
      } catch {}
      aria_snapshot = capAriaSnapshot(await ariaSnapshot(page));
      try {
        const extracted = await extractDocumentText(page);
        const textPath = join(outputDir, DOCUMENT_TEXT_FILENAME);
        await writeFile(textPath, extracted.text, "utf8");
        document_text = {
          path: textPath,
          chars: extracted.text.length,
          truncated: extracted.truncated
        };
      } catch {}
      blocked_affordances = await detectBlockedAffordances(page);
    }
    if (captureTransportFailed) {
      throw new AuditNavigationError(null, "capture_transport");
    }
    await context.close();
    return {
      screenshot_path: screenshotPath,
      images,
      text_issues,
      nav_status: navStatus,
      mobile_layout,
      horizontal_scrollers,
      unreachable_controls,
      clipped,
      interactive_nodes,
      fullpage_screenshot_path,
      aria_snapshot,
      document_text,
      blocked_affordances,
      readiness,
      color_scheme,
      launch_ms
    };
  } catch (error) {
    if (captureTransportFailed) {
      throw new AuditNavigationError(null, "capture_transport");
    }
    throw error;
  } finally {
    if (ownsBrowser) {
      await browser.close();
    }
  }
}
async function runAudit(args) {
  const started = performance.now();
  navRetriesThisRun = 0;
  const report = emptyReport(args);
  const consoleErrors = [];
  const consoleWarnings = [];
  const blockedRequests = [];
  const externalRequests = newExternalRequestLog();
  const brokenAssets = [];
  const externalFetchFailures = { count: 0, samples: [] };
  const outputDir = args.outputDir;
  let sharedLaunchFailed = false;
  let concurrentDesktopRetried = false;
  let concurrentMobileRetried = false;
  logAuditEvent("start", {
    slug: args.slug,
    capture: args.captureMode
  });
  await mkdir(outputDir, { recursive: true });
  let executablePath = findSystemChrome();
  if (executablePath === null && !args.skipInstall) {
    try {
      await ensureChromium();
    } catch (err) {
      report.ok = false;
      report.error = `chromium install failed: ${err.message}`;
      report.duration_ms = performance.now() - started;
      report.console_errors = consoleErrors;
      return report;
    }
  }
  let pw;
  try {
    pw = await loadPlaywright();
  } catch (err) {
    report.ok = false;
    report.error = `playwright module not loadable: ${err.message}`;
    report.duration_ms = performance.now() - started;
    report.console_errors = consoleErrors;
    return report;
  }
  let sharedBrowser = null;
  let sharedLaunchMs = 0;
  try {
    const sharedLaunchStartedAt = performance.now();
    sharedBrowser = await pw.chromium.launch(buildLaunchOptions(executablePath, args.proxyServer, args.proxyAuthToken, args.proxyAuthUsername));
    sharedLaunchMs = performance.now() - sharedLaunchStartedAt;
    logAuditEvent("shared_browser_launched", { launch_ms: sharedLaunchMs });
  } catch (err) {
    sharedLaunchFailed = true;
    consoleErrors.push(`shared browser launch failed; using per-pass launches: ${err.message}`);
    logAuditEvent("shared_browser_launch_failed", {
      error: err.message?.slice(0, 160)
    });
    sharedBrowser = null;
  }
  const liveShared = () => sharedBrowser !== null && sharedBrowser.isConnected() ? sharedBrowser : null;
  let concurrentViewportsRan = false;
  try {
    const runDesktop = async () => {
      const desktopStartedAt = performance.now();
      try {
        const desktop = await captureViewport(pw, args.url, args.slug, args.routeSlug, DESKTOP_VIEWPORT, outputDir, SCREENSHOT_FILENAME, consoleErrors, consoleWarnings, blockedRequests, externalRequests, brokenAssets, externalFetchFailures, false, executablePath, args.notaryToken, args.auditSessionId, args.proxyServer, args.proxyAuthToken, args.proxyAuthUsername, args.egressLockdown, liveShared(), args.sandboxApiSocket ?? null);
        report.viewports.desktop.screenshot_path = desktop.screenshot_path;
        report.viewports.desktop.fullpage_screenshot_path = desktop.fullpage_screenshot_path;
        report.unreachable_controls.desktop = desktop.unreachable_controls;
        report.clipped.desktop = desktop.clipped;
        report.aria_snapshot = desktop.aria_snapshot;
        report.document_text = desktop.document_text;
        report.blocked_affordances = desktop.blocked_affordances;
        report.interactive_nodes = Math.max(report.interactive_nodes, desktop.interactive_nodes);
        report.nav_status = desktop.nav_status;
        report.images = desktop.images;
        report.text_issues = desktop.text_issues;
        report.readiness.desktop = desktop.readiness;
        report.color_scheme = desktop.color_scheme;
        report.cold_launch_ms = sharedBrowser !== null ? sharedLaunchMs : desktop.launch_ms;
        return true;
      } catch (err) {
        report.ok = false;
        report.error = `desktop capture failed: ${err.message}`;
        if (err instanceof AuditNavigationError) {
          report.nav_status = err.status;
          report.error_kind = err.error_kind;
        }
        return false;
      } finally {
        report.desktop_ms = performance.now() - desktopStartedAt;
      }
    };
    const runMobile = async () => {
      if (args.captureMode === CAPTURE_MODE_DESKTOP_ONLY)
        return true;
      const mobileStartedAt = performance.now();
      try {
        const mobile = await captureViewport(pw, args.url, args.slug, args.routeSlug, MOBILE_VIEWPORT, outputDir, MOBILE_SCREENSHOT_FILENAME, consoleErrors, consoleWarnings, blockedRequests, externalRequests, brokenAssets, externalFetchFailures, true, executablePath, args.notaryToken, args.auditSessionId, args.proxyServer, args.proxyAuthToken, args.proxyAuthUsername, args.egressLockdown, liveShared(), args.sandboxApiSocket ?? null);
        report.viewports.mobile.screenshot_path = mobile.screenshot_path;
        report.mobile_layout = mobile.mobile_layout;
        report.horizontal_scrollers = mobile.horizontal_scrollers;
        report.unreachable_controls.mobile = mobile.unreachable_controls;
        report.clipped.mobile = mobile.clipped;
        report.interactive_nodes = Math.max(report.interactive_nodes, mobile.interactive_nodes);
        report.readiness.mobile = mobile.readiness;
        report.color_scheme ??= mobile.color_scheme;
        return true;
      } catch (err) {
        consoleErrors.push(`mobile capture failed: ${err.message}`);
        return false;
      } finally {
        report.mobile_ms = performance.now() - mobileStartedAt;
      }
    };
    const runConcurrentViewports = sharedBrowser !== null && args.captureMode !== CAPTURE_MODE_DESKTOP_ONLY;
    if (runConcurrentViewports) {
      const [desktopOk, mobileOk] = await Promise.all([runDesktop(), runMobile()]);
      concurrentViewportsRan = true;
      if (!desktopOk) {
        concurrentDesktopRetried = true;
        logAuditEvent("concurrent_desktop_retry", {
          reason: "desktop failed under concurrency; retrying serially"
        });
        report.ok = true;
        report.error = undefined;
        report.error_kind = undefined;
        await runDesktop();
      }
      if (!mobileOk) {
        concurrentMobileRetried = true;
        logAuditEvent("concurrent_mobile_retry", {
          reason: "mobile failed under concurrency; retrying serially"
        });
        await runMobile();
      }
    } else {
      await runDesktop();
      await runMobile();
    }
  } finally {
    if (sharedBrowser !== null) {
      await sharedBrowser.close().catch(() => {});
    }
  }
  report.browser_launches = sharedBrowser !== null ? 1 : 1 + (args.captureMode !== CAPTURE_MODE_DESKTOP_ONLY ? 1 : 0);
  report.audit_path = concurrentViewportsRan ? "shared-concurrent" : sharedBrowser !== null ? "shared" : "current";
  report.console_errors = consoleErrors;
  report.console_warnings = consoleWarnings;
  report.external_fetch_failures = externalFetchFailures.count;
  report.external_fetch_failure_samples = externalFetchFailures.samples;
  report.blocked_requests = blockedRequests;
  report.external_requests = externalRequests.requests;
  report.external_requests_dropped = externalRequests.dropped;
  report.external_requests_dropped_data_bearing = externalRequests.dropped_data_bearing;
  const ledger = args.transport;
  report.transport_ledger_active = ledger !== null;
  report.egress_lockdown = args.egressLockdown;
  if (ledger !== null) {
    report.transport_connections = [...ledger.state.entries.values()];
    report.transport_udp_attempts = ledger.state.udp_attempts;
    report.transport_overflow = ledger.state.overflow;
    const explained = new Set;
    const auditDestination = ledgerDestinationKey(args.url);
    if (auditDestination !== null) {
      explained.add(auditDestination);
    }
    for (const request of externalRequests.requests) {
      const destination = ledgerDestinationKey(request.url);
      if (destination !== null) {
        explained.add(destination);
      }
    }
    report.unexplained_transport_hosts = unexplainedTransportHosts(ledger.state, explained);
  }
  report.broken_assets = dedupeBrokenAssets(brokenAssets);
  report.duration_ms = performance.now() - started;
  report.diagnostics = {
    audit_path: report.audit_path ?? "current",
    concurrent_ran: concurrentViewportsRan,
    concurrent_desktop_retry: concurrentDesktopRetried,
    concurrent_mobile_retry: concurrentMobileRetried,
    shared_launch_failed: sharedLaunchFailed,
    nav_retries: navRetriesThisRun,
    settle_retries: (report.readiness.desktop?.retried ? 1 : 0) + (report.readiness.mobile?.retried ? 1 : 0)
  };
  logAuditEvent("done", {
    ok: report.ok,
    duration_ms: report.duration_ms,
    audit_path: report.audit_path,
    browser_launches: report.browser_launches,
    cold_launch_ms: report.cold_launch_ms,
    desktop_ms: report.desktop_ms,
    mobile_ms: report.mobile_ms,
    interactive_nodes: report.interactive_nodes,
    diagnostics: report.diagnostics
  });
  return report;
}
var RELAY_START_FAILURE_MARKER = "hatch-egress-relay-start-failure";
var RELAY_START_FAILURE_MESSAGE = "proxy-auth relay failed to start; refusing to pass egress token to Chromium";
var LEDGER_START_FAILURE_MARKER = "hatch-transport-ledger-start-failure";
var LEDGER_START_FAILURE_MESSAGE = "transport ledger failed to start; audit aborted (retryable)";
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
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}
`);
    return 1;
  }
  const tokens = await readAuditTokensFromStdin();
  args = {
    ...args,
    notaryToken: tokens.notaryToken,
    proxyAuthToken: tokens.proxyAuthToken
  };
  let proxyRelay = null;
  let relayStartFailure = null;
  const upstreamProxyServer = args.proxyServer;
  if (args.proxyServer !== null && args.proxyAuthToken !== null) {
    try {
      proxyRelay = await startProxyAuthRelay(args.proxyServer, args.proxyAuthUsername ?? "hatch-runtime", args.proxyAuthToken, { connectOnly: true });
      args = { ...args, proxyServer: proxyRelay.server, proxyAuthToken: null };
    } catch {
      process.stderr.write(`playwright-audit: ${RELAY_START_FAILURE_MARKER}: ${RELAY_START_FAILURE_MESSAGE}
`);
      proxyRelay = null;
      relayStartFailure = RELAY_START_FAILURE_MESSAGE;
    }
  }
  let transportLedger = null;
  let ledgerStartFailure = null;
  if (args.proxyServer !== null && relayStartFailure === null) {
    try {
      const auditDestination = ledgerDestinationKey(args.url);
      if (auditDestination === null) {
        throw new Error(`audit url has no TCP destination: ${args.url}`);
      }
      transportLedger = await startTransportLedger(args.proxyServer, args.egressLockdown ? { allowedDestinations: new Set([auditDestination]) } : {});
      args = {
        ...args,
        proxyServer: transportLedger.server,
        transport: transportLedger
      };
    } catch {
      transportLedger = null;
      if (args.egressLockdown) {
        process.stderr.write(`playwright-audit: ${LEDGER_START_FAILURE_MARKER}: ${LEDGER_START_FAILURE_MESSAGE}
`);
        ledgerStartFailure = LEDGER_START_FAILURE_MESSAGE;
      } else {
        process.stderr.write(`playwright-audit: transport ledger failed to start; continuing unobserved (no lockdown requested)
`);
        if (proxyRelay !== null && upstreamProxyServer !== null && tokens.proxyAuthToken !== null) {
          try {
            await proxyRelay.close();
          } catch {}
          proxyRelay = await startProxyAuthRelay(upstreamProxyServer, args.proxyAuthUsername ?? "hatch-runtime", tokens.proxyAuthToken);
          args = { ...args, proxyServer: proxyRelay.server };
        }
      }
    }
  }
  const startFailure = relayStartFailure ?? ledgerStartFailure;
  let report;
  try {
    if (startFailure !== null) {
      throw new Error(startFailure);
    }
    report = await runAudit(args);
  } catch (err) {
    report = {
      ok: false,
      url: args.url,
      duration_ms: 0,
      output_dir: args.outputDir,
      nav_status: null,
      viewports: {
        desktop: { ...DESKTOP_VIEWPORT, screenshot_path: null, fullpage_screenshot_path: null },
        mobile: { ...MOBILE_VIEWPORT, screenshot_path: null }
      },
      mobile_layout: null,
      horizontal_scrollers: [],
      unreachable_controls: { desktop: [], mobile: [] },
      images: {
        total: 0,
        broken: [],
        duplicate: [],
        unstable: [],
        failed_requests: [],
        external_blocked: { count: 0, sample: [] },
        sample_urls: [],
        verdict: "pass"
      },
      text_issues: [],
      clipped: { desktop: [], mobile: [] },
      console_errors: [],
      console_warnings: [],
      external_fetch_failures: 0,
      external_fetch_failure_samples: [],
      blocked_requests: [],
      external_requests: [],
      external_requests_dropped: 0,
      external_requests_dropped_data_bearing: 0,
      transport_ledger_active: false,
      egress_lockdown: args.egressLockdown,
      transport_connections: [],
      transport_udp_attempts: 0,
      transport_overflow: 0,
      unexplained_transport_hosts: [],
      broken_assets: [],
      blocked_affordances: [],
      aria_snapshot: null,
      document_text: null,
      interactive_nodes: 0,
      audit_session_id: args.auditSessionId,
      readiness: { desktop: null, mobile: null },
      color_scheme: null,
      error: startFailure !== null ? startFailure : `unexpected: ${err.message}`
    };
  } finally {
    if (transportLedger !== null) {
      try {
        await transportLedger.close();
      } catch {}
    }
    if (proxyRelay !== null) {
      try {
        await proxyRelay.close();
      } catch {}
    }
  }
  const reportPath = join(args.outputDir, "report.json");
  await mkdir(args.outputDir, { recursive: true });
  const reportBytes = JSON.stringify(report, null, 2) + `
`;
  await writeFile(reportPath, reportBytes);
  process.stdout.write(`report-sha256:${createHash("sha256").update(reportBytes).digest("hex")}
`);
  process.stdout.write(reportPath + `
`);
  return 0;
}
if (import.meta.main) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`playwright-audit fatal: ${String(err)}
`);
    process.exit(1);
  });
}
export {
  CHROME_HARDENING_ARGS,
  CHROME_PHONE_HOME_BYPASS_HOSTS,
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  attachAuditNetworkPolicy,
  buildLaunchOptions,
  capAriaSnapshot,
  classifyHorizontalScrollers,
  classifyImageSource,
  classifyMobileOverflow,
  collectRawImages,
  confirmTransientUnreachable,
  dedupeAndSample,
  dedupeBrokenAssets,
  ensureChromium,
  findSystemChrome,
  formatConsoleError,
  formatConsoleWarning,
  installPageDiagnostics,
  isAuditRequestAllowed,
  isDaemonRootFaviconRequest,
  isDataBearingRequest,
  isExternalFetchFailure,
  isHighPriorityWarning,
  isTransientNavError,
  isTransientNavStatus,
  loadPlaywright,
  navigateAndSettle,
  navigateForCapture,
  newExternalRequestLog,
  parseArgs,
  parseCaptureMode,
  readAuditTokensFromStdin,
  readBodyText,
  recordExternalRequest,
  safeOrigin,
  scanTextIssues,
  settleForCapture,
  startProxyAuthRelay,
  summarizeImages
};
