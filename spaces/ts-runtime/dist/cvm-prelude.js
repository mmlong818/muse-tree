(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;

  // src/prelude.ts
  var exports_prelude = {};

  // src/tunnel-url.ts
  var B64_CHUNK = 32768;
  function computeSelfBaseDir(selfHref) {
    if (!selfHref)
      return "";
    let h = selfHref;
    const hash = h.indexOf("#");
    if (hash >= 0)
      h = h.slice(0, hash);
    const q = h.indexOf("?");
    if (q >= 0)
      h = h.slice(0, q);
    const slash = h.lastIndexOf("/");
    return slash >= 0 ? h.slice(0, slash + 1) : "";
  }
  function isSelfOriginUrl(u, selfBaseDir, selfHref, objectUrls) {
    if (!selfBaseDir || !u.startsWith(selfBaseDir))
      return false;
    if (u === selfHref)
      return false;
    return !objectUrls.has(u);
  }
  function isExternalUrl(u, selfBaseDir, selfHref, objectUrls) {
    if (!u)
      return false;
    if (u.startsWith("#"))
      return true;
    if (isSelfOriginUrl(u, selfBaseDir, selfHref, objectUrls))
      return false;
    if (u.startsWith("data:") || u.startsWith("blob:"))
      return true;
    if (u.startsWith("about:") || u.startsWith("javascript:"))
      return true;
    if (u.startsWith("//"))
      return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      return true;
    }
    return false;
  }
  function normalizeToRelPath(u, selfBaseDir) {
    let s = u;
    if (selfBaseDir && s.startsWith(selfBaseDir)) {
      s = s.slice(selfBaseDir.length);
    }
    s = s.replace(/^\.\//, "");
    s = s.replace(/^\/+/, "");
    return s;
  }
  function blobInner(base, NativeURL) {
    if (base == null)
      return null;
    const s = typeof base === "string" ? base : base instanceof NativeURL ? base.href : String(base);
    return s.startsWith("blob:") ? s.slice("blob:".length) : null;
  }
  var OPAQUE_BLOB_ORIGIN = "https://hatch-cvm-opaque.invalid";
  function isAbsoluteUrlString(s, NativeURL) {
    try {
      new NativeURL(s);
      return true;
    } catch {
      return false;
    }
  }
  function resolveAgainstBlobBase(u, base, NativeURL) {
    const inner = blobInner(base, NativeURL);
    if (inner === null)
      return null;
    if (isAbsoluteUrlString(inner, NativeURL)) {
      return new NativeURL("blob:" + new NativeURL(u, inner).href);
    }
    const slash = inner.indexOf("/");
    const token = slash >= 0 ? inner.slice(0, slash) : inner;
    const path = slash >= 0 ? inner.slice(slash) : "/";
    const resolved = new NativeURL(u, OPAQUE_BLOB_ORIGIN + path);
    return new NativeURL("blob:" + token + resolved.pathname + resolved.search + resolved.hash);
  }
  function resolveTunnelUrl(url, base, selfHref, NativeURL) {
    const u = url == null ? "" : typeof url === "string" ? url : url instanceof NativeURL ? url.href : String(url);
    const uAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");
    if (base !== undefined && base !== null && !uAbsolute) {
      const viaBlob = resolveAgainstBlobBase(u, base, NativeURL);
      if (viaBlob !== null)
        return viaBlob;
      return new NativeURL(u, base);
    }
    if (!uAbsolute && selfHref) {
      const viaBlob = resolveAgainstBlobBase(u, selfHref, NativeURL);
      if (viaBlob !== null)
        return viaBlob;
    }
    return base === undefined ? new NativeURL(u) : new NativeURL(u, base);
  }
  function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0;i < u8.length; i += B64_CHUNK) {
      s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + B64_CHUNK)));
    }
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0;i < bin.length; i++)
      out[i] = bin.charCodeAt(i);
    return out;
  }
  function importMetaUrl(selfHref, selfBaseDir) {
    return selfBaseDir ? `${selfBaseDir}assets/cvm-bundle.js` : selfHref;
  }

  // src/download-links.ts
  function installDownloadLinks(fetchAsset, isExternalUrl, revokeDelayMs) {
    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (!anchor?.hasAttribute("download"))
        return;
      const href = anchor.getAttribute("href");
      if (!href || isExternalUrl(href))
        return;
      event.preventDefault();
      const filename = anchor.download || resourceFilename(href);
      (async () => {
        const response = await fetchAsset(href);
        if (!response.ok) {
          throw new Error(`Artifact download failed: HTTP ${response.status}`);
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.hidden = true;
        document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
        }
      })().catch((error) => reportError(error));
    });
  }
  function resourceFilename(href) {
    const path = new URL(href, document.baseURI).pathname;
    const name = path.slice(path.lastIndexOf("/") + 1);
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  }

  // src/fragment-links.ts
  function installFragmentLinks() {
    if (!location.href.startsWith("blob:null/"))
      return;
    const NativeURL = URL;
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    window.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (!anchor || anchor.hasAttribute("download"))
        return;
      const targetName = anchor.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? "";
      if (targetName !== "" && targetName.toLowerCase() !== "_self")
        return;
      const href = anchor.getAttribute("href");
      if (!href?.startsWith("#"))
        return;
      const oldURL = location.href;
      const nextURL = new NativeURL(href, oldURL);
      event.preventDefault();
      const changed = nextURL.href !== oldURL;
      if (changed) {
        pushState(null, "", nextURL.href);
      } else {
        replaceState(null, "", nextURL.href);
      }
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      const target = fragmentTarget(nextURL.hash);
      if (target) {
        target.scrollIntoView();
        if (target !== document.documentElement && (target instanceof HTMLElement || target instanceof SVGElement)) {
          const hadTabIndex = target.hasAttribute("tabindex");
          if (!hadTabIndex)
            target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
          if (!hadTabIndex)
            target.removeAttribute("tabindex");
        }
      }
      if (changed) {
        queueMicrotask(() => window.dispatchEvent(new HashChangeEvent("hashchange", {
          oldURL,
          newURL: nextURL.href
        })));
      }
    });
  }
  function fragmentTarget(hash) {
    const bytes = hash.slice(1).replace(/%([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    const fragment = new TextDecoder().decode(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)));
    if (fragment === "")
      return document.documentElement;
    const idTarget = document.getElementById(fragment);
    if (idTarget)
      return idTarget;
    const namedTarget = Array.from(document.getElementsByName(fragment)).find((node) => node instanceof HTMLAnchorElement);
    return namedTarget ?? (fragment.toLowerCase() === "top" ? document.documentElement : null);
  }

  // src/prelude.ts
  (function installTunnel() {
    installFragmentLinks();
    let port = null;
    let portReadyResolve = null;
    const portReady = new Promise((res) => {
      portReadyResolve = res;
    });
    const pending = new Map;
    const openWs = new Map;
    function newId() {
      return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    }
    function bytesToB64(bytes) {
      return bytesToBase64(bytes);
    }
    function b64ToBytes(b64) {
      return base64ToBytes(b64);
    }
    async function httpReq(method, path, body, headers) {
      const p = port ?? await portReady;
      const id = newId();
      const headerArr = [];
      if (headers) {
        const h = new Headers(headers);
        h.forEach((v, k) => headerArr.push([k, v]));
      }
      let bodyB64 = "";
      if (body != null && body !== "") {
        let bytes;
        if (typeof body === "string") {
          bytes = new TextEncoder().encode(body);
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body);
        } else if (body instanceof Uint8Array) {
          bytes = body;
        } else if (body instanceof Blob) {
          bytes = new Uint8Array(await body.arrayBuffer());
        } else if (body instanceof FormData) {
          const boundary = "----HatchBoundary" + Math.random().toString(36).slice(2);
          let s = "";
          for (const [k, v] of body.entries()) {
            s += `--${boundary}\r
Content-Disposition: form-data; name="${k}"`;
            if (v instanceof File) {
              s += `; filename="${v.name}"\r
Content-Type: ${v.type || "application/octet-stream"}\r
\r
`;
              const fb = new Uint8Array(await v.arrayBuffer());
              s += new TextDecoder("latin1").decode(fb);
            } else {
              s += `\r
\r
${v}`;
            }
            s += `\r
`;
          }
          s += `--${boundary}--\r
`;
          bytes = new TextEncoder().encode(s);
          headerArr.push([
            "content-type",
            `multipart/form-data; boundary=${boundary}`
          ]);
        } else {
          bytes = new TextEncoder().encode(String(body));
        }
        bodyB64 = bytesToB64(bytes);
      }
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (msg) => {
            if (msg.error) {
              reject(new Error(msg.error.message ?? "tunnel error"));
              return;
            }
            resolve({
              status: msg.status,
              headers: msg.headers,
              bytes: msg.bodyB64 ? b64ToBytes(msg.bodyB64) : new Uint8Array(0)
            });
          },
          reject
        });
        p.postMessage({
          type: "http.req",
          id,
          method,
          path,
          headers: headerArr,
          bodyB64
        });
      });
    }
    async function tunnelFetch(input, init) {
      let urlStr;
      let method = init?.method ?? "GET";
      let headers = init?.headers;
      let body = init?.body;
      if (input instanceof Request) {
        urlStr = input.url;
        method = init?.method ?? input.method;
        headers = init?.headers ?? input.headers;
        if (body == null && input.body) {
          body = await input.arrayBuffer();
        }
      } else {
        urlStr = String(input);
      }
      if (isExternalUrl2(urlStr)) {
        return originalFetch(input, init);
      }
      const relPath = normalizeToRelPath2(urlStr);
      const r = await httpReq(method, relPath, body ?? null, headers);
      const respHeaders = new Headers;
      for (const [k, v] of r.headers ?? [])
        respHeaders.set(k, v);
      return new Response(r.bytes, {
        status: r.status,
        headers: respHeaders
      });
    }

    class TunnelWebSocket extends EventTarget {
      readyState = 0;
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;
      url;
      binaryType = "blob";
      bufferedAmount = 0;
      protocol = "";
      extensions = "";
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      _id;
      constructor(urlIn, _protocols) {
        super();
        const urlStr = String(urlIn);
        this.url = urlStr;
        this._id = newId();
        openWs.set(this._id, this);
        const path = normalizeToRelPath2(urlStr);
        (async () => {
          const p = port ?? await portReady;
          p.postMessage({ type: "ws.open", id: this._id, path });
        })();
      }
      _handle(msg) {
        if (msg.type === "ws.opened") {
          this.readyState = 1;
          const ev = new Event("open");
          this.onopen?.(ev);
          this.dispatchEvent(ev);
        } else if (msg.type === "ws.message") {
          const bytes = msg.dataB64 ? b64ToBytes(msg.dataB64) : new Uint8Array(0);
          let data;
          if (msg.binary) {
            data = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
          } else {
            data = new TextDecoder().decode(bytes);
          }
          const ev = new MessageEvent("message", { data });
          this.onmessage?.(ev);
          this.dispatchEvent(ev);
        } else if (msg.type === "ws.closed") {
          this.readyState = 3;
          const ev = new CloseEvent("close", {
            code: msg.code ?? 1000,
            reason: msg.reason ?? ""
          });
          this.onclose?.(ev);
          this.dispatchEvent(ev);
          openWs.delete(this._id);
        } else if (msg.type === "ws.error") {
          const ev = new Event("error");
          this.onerror?.(ev);
          this.dispatchEvent(ev);
        }
      }
      send(data) {
        (async () => {
          const p = port ?? await portReady;
          let bytes;
          let binary = false;
          if (typeof data === "string") {
            bytes = new TextEncoder().encode(data);
          } else if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
            binary = true;
          } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
            binary = true;
          } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            binary = true;
          } else {
            bytes = new TextEncoder().encode(String(data));
          }
          p.postMessage({
            type: "ws.send",
            id: this._id,
            dataB64: bytesToB64(bytes),
            binary
          });
        })();
      }
      close(code, reason) {
        (async () => {
          const p = port ?? await portReady;
          p.postMessage({ type: "ws.close", id: this._id, code, reason });
        })();
      }
      addEventListener(type, listener, options) {
        super.addEventListener(type, listener, options);
      }
    }

    class TunnelXHR extends EventTarget {
      static UNSENT = 0;
      static OPENED = 1;
      static HEADERS_RECEIVED = 2;
      static LOADING = 3;
      static DONE = 4;
      UNSENT = 0;
      OPENED = 1;
      HEADERS_RECEIVED = 2;
      LOADING = 3;
      DONE = 4;
      readyState = 0;
      status = 0;
      statusText = "";
      responseText = "";
      response = null;
      responseType = "";
      responseURL = "";
      withCredentials = false;
      timeout = 0;
      upload = new EventTarget;
      onreadystatechange = null;
      onload = null;
      onerror = null;
      onloadend = null;
      onabort = null;
      onprogress = null;
      ontimeout = null;
      _method = "GET";
      _url = "";
      _reqHeaders = [];
      _respHeaders = [];
      _aborted = false;
      open(method, url) {
        this._method = method;
        this._url = url;
        this.readyState = 1;
        this.onreadystatechange?.();
      }
      setRequestHeader(name, value) {
        this._reqHeaders.push([name, value]);
      }
      getAllResponseHeaders() {
        return this._respHeaders.map(([k, v]) => `${k}: ${v}`).join(`\r
`);
      }
      getResponseHeader(name) {
        const lc = name.toLowerCase();
        const hit = this._respHeaders.find(([k]) => k.toLowerCase() === lc);
        return hit ? hit[1] : null;
      }
      abort() {
        this._aborted = true;
        this.readyState = 0;
      }
      send(body) {
        if (isExternalUrl2(this._url)) {
          const real = new originalXHR;
          real.open(this._method, this._url);
          for (const [k, v] of this._reqHeaders)
            real.setRequestHeader(k, v);
          real.onload = () => {
            this.status = real.status;
            this.responseText = real.responseText;
            this.response = real.response;
            this.readyState = 4;
            this.onreadystatechange?.();
            this.onload?.();
            this.onloadend?.();
            this.dispatchEvent(new Event("load"));
          };
          real.onerror = () => {
            this.onerror?.();
            this.dispatchEvent(new Event("error"));
          };
          real.send(body);
          return;
        }
        const relPath = normalizeToRelPath2(this._url);
        httpReq(this._method, relPath, body ?? null, this._reqHeaders).then((r) => {
          if (this._aborted)
            return;
          this.status = r.status;
          this._respHeaders = r.headers ?? [];
          this.responseText = new TextDecoder().decode(r.bytes);
          if (this.responseType === "arraybuffer") {
            this.response = r.bytes.buffer;
          } else if (this.responseType === "blob") {
            this.response = new Blob([r.bytes]);
          } else if (this.responseType === "json") {
            try {
              this.response = JSON.parse(this.responseText);
            } catch {
              this.response = null;
            }
          } else {
            this.response = this.responseText;
          }
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
          this.onloadend?.();
          this.dispatchEvent(new Event("load"));
        }, () => {
          if (this._aborted)
            return;
          this.onerror?.();
          this.dispatchEvent(new Event("error"));
        });
      }
    }

    class TunnelEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 0;
      url;
      withCredentials = false;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url) {
        super();
        this.url = String(url);
        (async () => {
          try {
            const relPath = normalizeToRelPath2(this.url);
            const r = await httpReq("GET", relPath, null, [
              ["accept", "text/event-stream"]
            ]);
            this.readyState = 1;
            this.onopen?.(new Event("open"));
            const text = new TextDecoder().decode(r.bytes);
            for (const block of text.split(/\n\n/)) {
              const data = block.split(`
`).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(`
`);
              if (data) {
                const ev = new MessageEvent("message", { data });
                this.onmessage?.(ev);
                this.dispatchEvent(ev);
              }
            }
            this.readyState = 2;
          } catch {
            this.onerror?.(new Event("error"));
          }
        })();
      }
      close() {
        this.readyState = 2;
      }
    }
    const SELF_HREF = (() => {
      try {
        return globalThis.location?.href ?? "";
      } catch {
        return "";
      }
    })();
    const SELF_BASE_DIR = computeSelfBaseDir(SELF_HREF);
    const objectUrls = new Set;
    function isSelfOriginUrl2(u) {
      return isSelfOriginUrl(u, SELF_BASE_DIR, SELF_HREF, objectUrls);
    }
    function isExternalUrl2(u) {
      return isExternalUrl(u, SELF_BASE_DIR, SELF_HREF, objectUrls);
    }
    function normalizeToRelPath2(u) {
      return normalizeToRelPath(u, SELF_BASE_DIR);
    }
    const URL_ATTRS = new Set([
      "src",
      "srcset",
      "href",
      "poster",
      "action",
      "formaction",
      "data",
      "background",
      "cite",
      "longdesc",
      "usemap",
      "manifest"
    ]);
    const URL_STYLE_PROPS = new Set([
      "background",
      "backgroundImage",
      "background-image",
      "borderImage",
      "border-image",
      "borderImageSource",
      "border-image-source",
      "listStyle",
      "list-style",
      "listStyleImage",
      "list-style-image",
      "cursor",
      "mask",
      "maskImage",
      "mask-image",
      "webkitMask",
      "-webkit-mask",
      "webkitMaskImage",
      "-webkit-mask-image",
      "content",
      "src"
    ]);
    const __BLOB_CACHE_MAX = 256;
    const __BLOB_REVOKE_DELAY_MS = 30000;
    const blobCache = new Map;
    const blobStats = {
      created: 0,
      revoked: 0,
      hits: 0,
      misses: 0,
      inFlightRevokes: 0
    };
    function __evictIfOverCap() {
      while (blobCache.size > __BLOB_CACHE_MAX) {
        const oldestKey = blobCache.keys().next().value;
        if (oldestKey === undefined)
          break;
        const ent = blobCache.get(oldestKey);
        blobCache.delete(oldestKey);
        blobStats.inFlightRevokes++;
        const t = setTimeout(() => {
          ent.url.then((u) => {
            if (typeof u === "string" && u.startsWith("blob:")) {
              try {
                URL.revokeObjectURL(u);
                blobStats.revoked++;
              } catch {}
            }
          }).finally(() => {
            blobStats.inFlightRevokes--;
          });
        }, __BLOB_REVOKE_DELAY_MS);
        ent.pendingRevoke = t;
      }
    }
    function resolveToBlobUrl(rel) {
      if (isExternalUrl2(rel))
        return Promise.resolve(rel);
      const hashIdx = rel.indexOf("#");
      const pathPart = hashIdx >= 0 ? rel.slice(0, hashIdx) : rel;
      const frag = hashIdx >= 0 ? rel.slice(hashIdx) : "";
      const key = normalizeToRelPath2(pathPart);
      let ent = blobCache.get(key);
      if (ent) {
        if (ent.pendingRevoke != null) {
          clearTimeout(ent.pendingRevoke);
          ent.pendingRevoke = undefined;
          blobStats.inFlightRevokes--;
        }
        blobCache.delete(key);
        blobCache.set(key, ent);
        blobStats.hits++;
      } else {
        blobStats.misses++;
        const url = httpReq("GET", key, null).then((r) => {
          const ctHeader = r.headers.find(([k]) => k.toLowerCase() === "content-type");
          const ct = ctHeader?.[1] ?? "application/octet-stream";
          const blob = new Blob([r.bytes], { type: ct });
          blobStats.created++;
          return URL.createObjectURL(blob);
        });
        ent = { url };
        blobCache.set(key, ent);
        __evictIfOverCap();
      }
      return frag ? ent.url.then((b) => b + frag) : ent.url;
    }
    const HATCH_PIXEL_PREFIX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    const HATCH_FRAG = "#hatch=";
    function isHatchPlaceholder(url) {
      return url.indexOf(HATCH_PIXEL_PREFIX + HATCH_FRAG) === 0;
    }
    function unwrapHatchPlaceholder(url) {
      if (!isHatchPlaceholder(url))
        return null;
      return decodeURIComponent(url.slice((HATCH_PIXEL_PREFIX + HATCH_FRAG).length));
    }
    async function rewriteCssTextAsync(text) {
      const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      const tasks = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        tasks.push({ match: m[0], index: m.index, url: m[2].trim() });
      }
      if (tasks.length === 0)
        return text;
      const resolved = await Promise.all(tasks.map(async (t) => {
        if (t.url.startsWith("blob:"))
          return t.url;
        const unwrapped = unwrapHatchPlaceholder(t.url);
        if (unwrapped != null) {
          try {
            return await resolveToBlobUrl(unwrapped);
          } catch {
            return t.url;
          }
        }
        if (isExternalUrl2(t.url))
          return t.url;
        try {
          return await resolveToBlobUrl(t.url);
        } catch {
          return t.url;
        }
      }));
      let out = "";
      let last = 0;
      tasks.forEach((t, i) => {
        out += text.slice(last, t.index);
        out += `url("${resolved[i]}")`;
        last = t.index + t.match.length;
      });
      out += text.slice(last);
      return out;
    }
    function rewriteCssText(text) {
      return rewriteCssTextAsync(text);
    }
    const mediaSourceLoads = new WeakMap;
    window.addEventListener("error", (event) => {
      const source = event.target;
      if (!event.isTrusted || !(source instanceof HTMLSourceElement) || !(source.parentElement instanceof HTMLMediaElement) || source.hasAttribute("src"))
        return;
      const state = mediaSourceLoads.get(source);
      if (state === "pending" || state === undefined && source.hasAttribute("data-hatch-src")) {
        event.stopImmediatePropagation();
      }
    }, true);
    function isElement(el) {
      if (el instanceof Element)
        return true;
      const ownerWindow = el?.ownerDocument?.defaultView;
      return ownerWindow != null && el instanceof ownerWindow.Element;
    }
    function setAttr(el, name, value, ...rest) {
      if (!isElement(el)) {
        return el.setAttribute(name, value, ...rest);
      }
      name = String(name);
      if (value == null) {
        if (name.toLowerCase() === "src" && el instanceof HTMLSourceElement) {
          mediaSourceLoads.set(el, "settled");
        }
        try {
          el.removeAttribute(name);
        } catch {}
        return;
      }
      const v = String(value);
      const lcName = name.toLowerCase();
      const tag = el.tagName?.toUpperCase();
      if ((tag === "A" || tag === "BASE" || tag === "AREA") && lcName === "href") {
        el.setAttribute(name, v);
        return;
      }
      if (!URL_ATTRS.has(lcName) && lcName !== "style" && lcName !== "srcset") {
        el.setAttribute(name, v);
        return;
      }
      if (lcName === "srcset") {
        const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
        Promise.all(parts.map(async (p) => {
          const segs = p.split(/\s+/);
          const url = segs[0];
          const rest = segs.slice(1).join(" ");
          if (isExternalUrl2(url))
            return p;
          const resolved = await resolveToBlobUrl(url);
          return rest ? `${resolved} ${rest}` : resolved;
        })).then((rebuilt) => {
          try {
            el.setAttribute("srcset", rebuilt.join(", "));
          } catch {}
        });
        return;
      }
      if (URL_ATTRS.has(lcName)) {
        const isMediaSource = tag === "SOURCE" && lcName === "src";
        if (isExternalUrl2(v)) {
          if (isMediaSource)
            mediaSourceLoads.set(el, "settled");
          el.setAttribute(name, v);
          return;
        }
        if (isMediaSource)
          mediaSourceLoads.set(el, "pending");
        if (tag === "IMG" || tag === "VIDEO" && lcName === "poster") {
          el.setAttribute(name, TRANSPARENT_PIXEL);
        }
        resolveToBlobUrl(v).then((blobUrl) => {
          if (isMediaSource)
            mediaSourceLoads.set(el, "settled");
          try {
            el.setAttribute(name, blobUrl);
            if (isMediaSource) {
              const media = el.parentElement;
              if (media instanceof HTMLMediaElement && media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
                const nextSibling = el.nextSibling;
                el.remove();
                media.insertBefore(el, nextSibling);
              }
            }
          } catch {}
        }, () => {
          if (isMediaSource) {
            mediaSourceLoads.set(el, "settled");
            el.dispatchEvent(new Event("error"));
          }
        });
        return;
      }
      if (lcName === "style") {
        setStyleAttr(el, v);
        return;
      }
      el.setAttribute(name, v);
    }
    function setAttrNS(el, ns, name, value, ...rest) {
      if (!isElement(el)) {
        return el.setAttributeNS(ns, name, value, ...rest);
      }
      name = String(name);
      if (value == null) {
        try {
          el.removeAttributeNS(ns ?? null, name);
        } catch {}
        return;
      }
      const v = String(value);
      const lcName = name.split(":").pop().toLowerCase();
      if (lcName === "href" && URL_ATTRS.has("href")) {
        if (isExternalUrl2(v)) {
          el.setAttributeNS(ns ?? null, name, v);
          return;
        }
        resolveToBlobUrl(v).then((blobUrl) => {
          try {
            el.setAttributeNS(ns ?? null, name, blobUrl);
          } catch {}
        }, () => {});
        return;
      }
      try {
        el.setAttributeNS(ns ?? null, name, v);
      } catch {}
    }
    function setUrlProp(el, name, value) {
      if (isElement(el)) {
        setAttr(el, name.toLowerCase(), value);
      } else {
        el[name] = value;
      }
      return value;
    }
    const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    const HTML_TAG_ATTRS = {
      img: ["src", "srcset", "poster"],
      image: ["href"],
      video: ["src", "poster"],
      audio: ["src"],
      source: ["src", "srcset"],
      script: ["src"],
      link: ["href"],
      iframe: ["src"],
      embed: ["src"],
      object: ["data"],
      track: ["src"],
      input: ["src"],
      form: ["action"],
      button: ["formaction"],
      use: ["href"]
    };
    function rewriteHtmlString(html) {
      return html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m, tag, attrs) => {
        const lc = String(tag).toLowerCase();
        const candidates = HTML_TAG_ATTRS[lc];
        if (!candidates)
          return m;
        let out = attrs;
        for (const a of candidates) {
          const re = new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
          const matched = out.match(re);
          if (!matched)
            continue;
          const value = matched[2] ?? matched[3] ?? matched[4] ?? "";
          if (isExternalUrl2(value))
            continue;
          out = out.replace(re, `data-hatch-${a}="${value.replace(/"/g, "&quot;")}"`);
        }
        const styleRe = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i;
        const sm = out.match(styleRe);
        if (sm) {
          const value = sm[2] ?? sm[3] ?? "";
          if (value.includes("url(")) {
            out = out.replace(styleRe, `data-hatch-style="${value.replace(/"/g, "&quot;")}"`);
          }
        }
        return `<${tag}${out}>`;
      });
    }
    const HTML_URL_ATTRS_BY_TAG = {
      IMG: ["src", "srcset", "poster"],
      IMAGE: ["href"],
      VIDEO: ["src", "poster"],
      AUDIO: ["src"],
      SOURCE: ["src", "srcset"],
      SCRIPT: ["src"],
      LINK: ["href"],
      IFRAME: ["src"],
      EMBED: ["src"],
      OBJECT: ["data"],
      TRACK: ["src"],
      INPUT: ["src"],
      FORM: ["action"],
      BUTTON: ["formaction"],
      USE: ["href", "xlink:href"]
    };
    function rewriteSubtreeForTunnel(root) {
      if (!root)
        return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n = walker.currentNode;
      if (root.nodeType === 1)
        processOne(root);
      while (n = walker.nextNode()) {
        processOne(n);
      }
    }
    function processOne(el) {
      const tag = (el.tagName ?? "").toUpperCase();
      const attrs = HTML_URL_ATTRS_BY_TAG[tag];
      if (attrs) {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v == null)
            continue;
          if (isExternalUrl2(v))
            continue;
          el.setAttribute("data-hatch-" + a, v);
          el.removeAttribute(a);
        }
      }
      const style = el.getAttribute("style");
      if (style && style.includes("url(")) {
        el.setAttribute("data-hatch-style", style);
        el.removeAttribute("style");
      }
    }
    function parseAndCleanHtml(html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      rewriteSubtreeForTunnel(tpl.content);
      return tpl.content;
    }
    function setInnerHTML(el, html, which = "innerHTML") {
      const s = html == null ? "" : String(html);
      if (which === "innerHTML" && typeof el.tagName === "string" && el.tagName.toUpperCase() === "TEMPLATE") {
        try {
          el.innerHTML = s;
        } catch {}
        return;
      }
      if (which === "outerHTML") {
        const frag = parseAndCleanHtml(s);
        const wrap = document.createElement("div");
        wrap.appendChild(frag);
        try {
          el.outerHTML = wrap.innerHTML;
        } catch {}
        queueMicrotask(() => processDataHatchAttrs(document.body));
        return;
      }
      const frag = parseAndCleanHtml(s);
      try {
        while (el.firstChild)
          el.removeChild(el.firstChild);
        el.appendChild(frag);
      } catch {}
      queueMicrotask(() => processDataHatchAttrs(el));
    }
    function insertAdjacentHTMLT(el, position, html) {
      const s = html == null ? "" : String(html);
      const frag = parseAndCleanHtml(s);
      const wrap = document.createElement("template");
      wrap.content.appendChild(frag);
      try {
        el.insertAdjacentHTML(position, wrap.innerHTML);
      } catch {}
      queueMicrotask(() => processDataHatchAttrs(document.body));
    }
    function processDataHatchAttrs(root) {
      const SELECTORS = "[data-hatch-src], [data-hatch-href], [data-hatch-srcset], [data-hatch-poster], [data-hatch-action], [data-hatch-data], [data-hatch-style]";
      root.querySelectorAll(SELECTORS).forEach((el) => {
        const attrs = el.getAttributeNames();
        for (const a of attrs) {
          if (!a.startsWith("data-hatch-"))
            continue;
          const real = a.slice("data-hatch-".length);
          const value = el.getAttribute(a) ?? "";
          el.removeAttribute(a);
          if (real === "style")
            setStyleAttr(el, value);
          else
            setAttr(el, real, value);
        }
      });
    }
    const styleProxyCache = new WeakMap;
    function getStyle(el) {
      if (el == null)
        return el;
      let real;
      try {
        real = el.style;
      } catch {
        return;
      }
      if (real == null || typeof real !== "object" && typeof real !== "function") {
        return real;
      }
      let proxy = styleProxyCache.get(real);
      if (proxy)
        return proxy;
      proxy = new Proxy(real, {
        get(target, prop, _receiver) {
          const v = Reflect.get(target, prop, target);
          if (typeof v === "function")
            return v.bind(target);
          return v;
        },
        set(target, prop, value) {
          if (typeof prop === "string") {
            setStyle(el, prop, value);
            return true;
          }
          return Reflect.set(target, prop, value, target);
        }
      });
      styleProxyCache.set(real, proxy);
      return proxy;
    }
    function setStyle(el, propName, value) {
      const v = value == null ? "" : String(value);
      if (propName.startsWith("--")) {
        rewriteCssText(v).then((rewritten) => {
          try {
            el.style.setProperty(propName, rewritten);
          } catch {}
        });
        return;
      }
      if (URL_STYLE_PROPS.has(propName) && v.includes("url(")) {
        rewriteCssText(v).then((rewritten) => {
          try {
            el.style[propName] = rewritten;
          } catch {}
        });
        return;
      }
      try {
        el.style[propName] = v;
      } catch {}
    }
    function setStyleAttr(el, attrValue) {
      if (!attrValue.includes("url(")) {
        el.setAttribute("style", attrValue);
        return;
      }
      rewriteCssText(attrValue).then((rewritten) => {
        try {
          el.setAttribute("style", rewritten);
        } catch {}
      });
    }
    function setStyleText(styleEl, text) {
      if (!(styleEl instanceof HTMLStyleElement)) {
        try {
          styleEl.textContent = text;
        } catch {}
        return;
      }
      if (!text.includes("url(")) {
        styleEl.textContent = text;
        return;
      }
      rewriteCssText(text).then((rewritten) => {
        try {
          styleEl.textContent = rewritten;
        } catch {}
      });
    }
    function tunnelImage(_w, _h) {
      const img = new originalImage;
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (desc?.set) {
        const origSet = desc.set;
        const origGet = desc.get;
        Object.defineProperty(img, "src", {
          configurable: true,
          get() {
            return origGet.call(img);
          },
          set(v) {
            if (v == null)
              return origSet.call(img, "");
            const s = String(v);
            if (isExternalUrl2(s))
              return origSet.call(img, s);
            resolveToBlobUrl(s).then((b) => origSet.call(img, b), () => origSet.call(img, s));
          }
        });
      }
      return img;
    }
    function tunnelSendBeacon(url, data) {
      tunnelFetch(url, { method: "POST", body: data, keepalive: true }).catch(() => {});
      return true;
    }
    function tunnelWorker(_url) {
      throw new Error("[__tunnel] new Worker() is not supported in Muse web artifacts.");
    }
    function tunnelImport(spec) {
      throw new Error("[__tunnel] dynamic import() of '" + String(spec) + "' is not supported in Muse web artifacts.");
    }
    function installCssObserver() {
      try {
        const proto = window.CSSStyleSheet?.prototype;
        if (proto) {
          const origInsertRule = proto.insertRule;
          proto.insertRule = function(rule, index) {
            if (typeof rule === "string" && rule.includes("url(")) {
              const idx = origInsertRule.call(this, rule, index);
              rewriteCssText(rule).then((rewritten) => {
                if (rewritten !== rule) {
                  try {
                    this.deleteRule(idx);
                    origInsertRule.call(this, rewritten, idx);
                  } catch {}
                }
              });
              return idx;
            }
            return origInsertRule.call(this, rule, index);
          };
          const origReplace = proto.replace;
          if (origReplace) {
            proto.replace = function(text) {
              if (typeof text === "string" && text.includes("url(")) {
                return rewriteCssText(text).then((rewritten) => origReplace.call(this, rewritten));
              }
              return origReplace.call(this, text);
            };
          }
          const origReplaceSync = proto.replaceSync;
          if (origReplaceSync) {
            proto.replaceSync = function(text) {
              if (typeof text === "string" && text.includes("url(")) {
                const ret = origReplaceSync.call(this, text);
                rewriteCssText(text).then((rewritten) => {
                  try {
                    origReplaceSync.call(this, rewritten);
                  } catch {}
                });
                return ret;
              }
              return origReplaceSync.call(this, text);
            };
          }
        }
      } catch (e) {}
      function sweepSheet(sheet) {
        try {
          const rules = sheet.cssRules;
          for (let i = 0;i < rules.length; i++) {
            const rule = rules[i];
            const txt = rule.cssText;
            if (txt && (txt.includes(HATCH_FRAG) || txt.includes("url(") && !/url\(\s*["']?(blob:|https?:|data:image\/gif;base64,R0)/.test(txt))) {
              rewriteCssText(txt).then((rewritten) => {
                if (rewritten !== txt) {
                  try {
                    sheet.deleteRule(i);
                    sheet.insertRule(rewritten, i);
                  } catch {}
                }
              });
            }
          }
        } catch {}
      }
      function sweepAll() {
        for (const sheet of Array.from(document.styleSheets)) {
          sweepSheet(sheet);
        }
      }
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of Array.from(m.addedNodes)) {
            if (node instanceof HTMLStyleElement) {
              const txt = node.textContent ?? "";
              if (txt.includes("url(")) {
                rewriteCssText(txt).then((rewritten) => {
                  if (rewritten !== txt) {
                    try {
                      node.textContent = rewritten;
                    } catch {}
                  }
                });
              }
            } else if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
              node.addEventListener("load", () => sweepSheet(node.sheet), { once: true });
            }
          }
        }
      });
      mo.observe(document, { subtree: true, childList: true });
      Promise.resolve().then(sweepAll);
      setTimeout(sweepAll, 0);
      setTimeout(sweepAll, 50);
      setTimeout(sweepAll, 250);
    }
    function rewriteAuthoredHtml() {
      const SELECTORS = "[data-hatch-src], [data-hatch-href], [data-hatch-srcset]";
      document.querySelectorAll(SELECTORS).forEach((el) => {
        const src = el.getAttribute("data-hatch-src");
        const href = el.getAttribute("data-hatch-href");
        const srcset = el.getAttribute("data-hatch-srcset");
        if (src)
          setAttr(el, "src", src);
        if (href)
          setAttr(el, "href", href);
        if (srcset)
          setAttr(el, "srcset", srcset);
      });
    }
    let historyUrlWarned = false;
    function warnHistoryUrlDropped(method, url) {
      if (url === undefined || url === null)
        return;
      if (historyUrlWarned)
        return;
      historyUrlWarned = true;
      try {
        console.warn("[__tunnel] history." + method + "() was called with a URL; the URL was ignored. A Muse web artifact " + "renders in an opaque origin with no navigable URL of its own, so " + "the browser rejects any URL change. State kept in the URL will not " + "persist or survive a reload — keep it in component state, or in " + "the artifact's database through a server action.");
      } catch {}
    }
    const originalFetch = globalThis.fetch?.bind(globalThis) ?? (() => {
      throw new Error("no native fetch");
    });
    const originalXHR = globalThis.XMLHttpRequest;
    const originalImage = globalThis.Image;
    const tunnel = {
      fetch: tunnelFetch,
      XHR: TunnelXHR,
      WebSocket: TunnelWebSocket,
      EventSource: TunnelEventSource,
      Image: tunnelImage,
      Worker: tunnelWorker,
      import: tunnelImport,
      sendBeacon: tunnelSendBeacon,
      setAttr,
      setAttrNS,
      setUrlProp,
      setStyle,
      getStyle,
      setStyleAttr,
      setStyleText,
      setInnerHTML,
      insertAdjacentHTML: insertAdjacentHTMLT,
      rewriteCssText,
      resolveToBlobUrl,
      processDataHatchAttrs,
      rewriteHtmlString,
      _resolveUrlString: (v) => v,
      _resolveCssValue: (v) => v,
      _resolveCssText: (v) => v,
      _resolveStyleProp: (v) => v,
      _importMeta: {
        get url() {
          return importMetaUrl(SELF_HREF, SELF_BASE_DIR);
        }
      },
      _state: {
        get port() {
          return port;
        },
        get inFlight() {
          return pending.size;
        },
        get blobCacheSize() {
          return blobCache.size;
        },
        get blobStats() {
          return { ...blobStats };
        }
      }
    };
    globalThis.__tunnel = tunnel;
    window.__tunnel = tunnel;
    try {
      globalThis.fetch = tunnelFetch;
      window.fetch = tunnelFetch;
      globalThis.XMLHttpRequest = TunnelXHR;
      window.XMLHttpRequest = TunnelXHR;
      globalThis.WebSocket = TunnelWebSocket;
      window.WebSocket = TunnelWebSocket;
      globalThis.EventSource = TunnelEventSource;
      window.EventSource = TunnelEventSource;
      const nav = globalThis.navigator;
      if (nav && typeof nav.sendBeacon === "function") {
        nav.sendBeacon = (url, data) => tunnelSendBeacon(url, data);
      }
      const NativeURL = globalThis.URL;
      const TunnelURL = function(url, base) {
        return resolveTunnelUrl(url, base, SELF_HREF, NativeURL);
      };
      TunnelURL.prototype = NativeURL.prototype;
      for (const k of Object.getOwnPropertyNames(NativeURL)) {
        if (k === "prototype" || k === "length" || k === "name")
          continue;
        try {
          TunnelURL[k] = NativeURL[k];
        } catch {}
      }
      globalThis.URL = TunnelURL;
      window.URL = TunnelURL;
    } catch {}
    try {
      const hist = globalThis.history;
      if (hist && typeof hist.pushState === "function" && typeof hist.replaceState === "function") {
        const nativePushState = hist.pushState.bind(hist);
        const nativeReplaceState = hist.replaceState.bind(hist);
        hist.pushState = function(state, title, url) {
          warnHistoryUrlDropped("pushState", url);
          return nativePushState(state, title ?? "");
        };
        hist.replaceState = function(state, title, url) {
          warnHistoryUrlDropped("replaceState", url);
          return nativeReplaceState(state, title ?? "");
        };
      }
    } catch {}
    try {
      const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
      const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = function(obj) {
        const created = nativeCreateObjectURL(obj);
        try {
          objectUrls.add(created);
        } catch {}
        return created;
      };
      URL.revokeObjectURL = function(objectUrl) {
        try {
          objectUrls.delete(objectUrl);
        } catch {}
        nativeRevokeObjectURL(objectUrl);
      };
    } catch {}
    const announceEpoch = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    let announceTimer = null;
    function announce() {
      try {
        window.parent.postMessage({ type: "bundle:ready", epoch: announceEpoch }, "*");
      } catch {}
    }
    function startAnnouncing() {
      announce();
      announceTimer = setInterval(() => {
        if (port != null) {
          if (announceTimer != null)
            clearInterval(announceTimer);
          announceTimer = null;
          return;
        }
        announce();
      }, 120);
    }
    function onParentMessage(ev) {
      const data = ev.data;
      if (!data || typeof data !== "object")
        return;
      if (data.type === "bundle:init-port" && ev.ports && ev.ports[0]) {
        if (port != null)
          return;
        if (announceTimer != null) {
          clearInterval(announceTimer);
          announceTimer = null;
        }
        port = ev.ports[0];
        port.onmessage = (pe) => {
          const msg = pe.data;
          if (!msg || typeof msg !== "object")
            return;
          if (msg.type === "http.res") {
            const ent = pending.get(msg.id);
            if (ent) {
              pending.delete(msg.id);
              ent.resolve(msg);
            }
          } else if (msg.type === "ws.opened" || msg.type === "ws.message" || msg.type === "ws.closed" || msg.type === "ws.error") {
            openWs.get(msg.id)?._handle(msg);
          }
        };
        port.start?.();
        portReadyResolve?.(port);
        installCssObserver();
        rewriteAuthoredHtml();
        try {
          window.parent.postMessage({ type: "bundle:port-attached" }, "*");
        } catch {}
      }
    }
    window.addEventListener("message", onParentMessage);
    installDownloadLinks(tunnelFetch, isExternalUrl2, __BLOB_REVOKE_DELAY_MS);
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startAnnouncing();
    } else {
      document.addEventListener("DOMContentLoaded", startAnnouncing);
    }
  })();
})();
