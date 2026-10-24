#!/usr/bin/env bun
// @bun

// src/execute-privileged-cli.ts
import { pathToFileURL } from "url";

// ../sdk/src/server-contract.ts
var PRIVILEGED_HANDLERS_FORMAT = "hatch-space-privileged-handlers-v1";
function isPrivilegedHandlers(value) {
  return typeof value === "object" && value !== null && "format" in value && value.format === PRIVILEGED_HANDLERS_FORMAT && Array.isArray(value.entries);
}
var LEGACY_ACTION_BRAND = Symbol.for("@hatch/space-sdk/action");

// src/invocation_env.ts
import { AsyncLocalStorage } from "async_hooks";
var invocationEnv = new AsyncLocalStorage;
var WRAPPED_FETCH = Symbol.for("hatch.spaceWorker.invocationFetchProxy");
var ORIGINAL_FETCH = Symbol.for("hatch.spaceWorker.originalFetch");
async function withInvocationProxyEnv(proxyEnv, invoke) {
  return await invocationEnv.run({ proxyEnv }, invoke);
}
function installInvocationFetchProxy() {
  const currentFetch = globalThis.fetch;
  if (currentFetch[WRAPPED_FETCH]) {
    return;
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  const wrappedFetch = async (...args) => {
    const [input, init] = args;
    return await originalFetch(input, withInvocationProxy(input, init));
  };
  wrappedFetch[WRAPPED_FETCH] = true;
  wrappedFetch[ORIGINAL_FETCH] = originalFetch;
  globalThis.fetch = wrappedFetch;
}
function withInvocationProxy(input, init) {
  const proxyEnv = invocationEnv.getStore()?.proxyEnv;
  if (!proxyEnv) {
    return init;
  }
  const fetchInit = init;
  if (fetchInit && (hasConcreteFetchOverride(fetchInit.proxy) || hasConcreteFetchOverride(fetchInit.unix))) {
    return init;
  }
  const protocol = fetchInputProtocol(input);
  const proxy = proxyForProtocol(proxyEnv, protocol);
  if (!proxy) {
    return init;
  }
  return { ...init ?? {}, proxy };
}
function hasConcreteFetchOverride(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}
function fetchInputProtocol(input) {
  const url = fetchInputUrl(input);
  if (!url) {
    return;
  }
  try {
    return new URL(url).protocol;
  } catch {
    return;
  }
}
function fetchInputUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return;
}
function proxyForProtocol(proxyEnv, protocol) {
  if (protocol === "http:") {
    return firstProxyEnv(proxyEnv, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  }
  if (protocol === "https:") {
    return firstProxyEnv(proxyEnv, [
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy"
    ]);
  }
  return;
}
function firstProxyEnv(proxyEnv, keys) {
  for (const key of keys) {
    const value = proxyEnv[key]?.trim();
    if (value) {
      return value;
    }
  }
  return;
}

// src/execute-privileged-cli.ts
var PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
];
function parseArgs(argv) {
  let modulePath = "";
  let contractName = "";
  for (const arg of argv) {
    if (arg.startsWith("--module=")) {
      modulePath = arg.slice("--module=".length);
    } else if (arg.startsWith("--contract=")) {
      contractName = arg.slice("--contract=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!modulePath) {
    throw new Error("missing --module=<path>");
  }
  if (!contractName) {
    throw new Error("missing --contract=<name>");
  }
  return { modulePath, contractName };
}
async function readStdinJson() {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}
function collectHandlers(moduleExports) {
  const entries = [];
  function add(candidate) {
    if (isPrivilegedHandlers(candidate)) {
      entries.push(...candidate.entries);
    }
  }
  for (const value of Object.values(moduleExports)) {
    add(value);
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value)) {
        add(nested);
      }
    }
  }
  return entries;
}
async function execute() {
  const args = parseArgs(Bun.argv.slice(2));
  const moduleExports = await import(pathToFileURL(args.modulePath).href);
  const matches = collectHandlers(moduleExports).filter((entry) => entry.contract.name === args.contractName);
  if (matches.length === 0) {
    return {
      ok: false,
      error: `privileged implementation not found: ${args.contractName}`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `duplicate privileged implementation: ${args.contractName}`
    };
  }
  const entry = matches[0];
  if (entry === undefined) {
    return {
      ok: false,
      error: `privileged implementation not found: ${args.contractName}`
    };
  }
  const request = entry.contract.request.parse(await readStdinJson());
  const response = await entry.handler(request);
  return {
    ok: true,
    result: entry.contract.response.parse(response)
  };
}
function proxyEnvFromProcess() {
  const proxyEnv = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      proxyEnv[key] = value;
    }
  }
  return Object.keys(proxyEnv).length > 0 ? proxyEnv : undefined;
}
installInvocationFetchProxy();
withInvocationProxyEnv(proxyEnvFromProcess(), execute).catch((err) => {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err)
  };
}).then((response) => {
  process.stdout.write(`${JSON.stringify(response)}
`);
});
