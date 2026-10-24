#!/usr/bin/env bun
// @bun

// src/validate-server-actions-cli.ts
import { join as join2, relative as relative2 } from "path";
import { stat } from "fs/promises";

// src/validate-server-actions.ts
import { existsSync, statSync } from "fs";
import {
  basename,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve
} from "path";
var REASON_IMPORT_PRIVILEGED_IMPLEMENTATION = "web artifact action code must not import `server/src/privileged.ts`. " + "Import descriptors from `@space/privileged` and call `ctx.executePrivileged(...)` instead.";
var REASON_HOST_MODULE_IMPORT = "web artifact action code must not import Node/Bun host modules. " + "Move host-only behavior into `server/src/privileged.ts` and expose it through a typed privileged function.";
var REASON_PROCESS_GLOBAL = "web artifact action code must not read the `process` global. " + "Use the fixed ctx API, or move host-only behavior into a privileged function.";
var REASON_BUN_GLOBAL = "web artifact action code must not read the `Bun` global. " + "Use the fixed ctx API, or move host-only behavior into a privileged function.";
var REASON_REQUIRE_CALL = "web artifact action code must not call `require(...)`. " + "Use static portable imports, or move host-only behavior into a privileged function.";
var REASON_DYNAMIC_IMPORT = "web artifact action code must not call dynamic `import(...)`. " + "Use static portable imports so the build can validate portability.";
var REASON_SUBPROCESS_API = "web artifact action code must not use subprocess APIs. " + "Move subprocess or host-command behavior into `server/src/privileged.ts`.";
var REASON_EVAL_API = "web artifact action code must not use eval-like dynamic code execution.";
var HOST_MODULES = new Set([
  "bun",
  "bun:ffi",
  "bun:jsc",
  "child_process",
  "cluster",
  "crypto",
  "dns",
  "fs",
  "fs/promises",
  "module",
  "net",
  "node:child_process",
  "node:cluster",
  "node:crypto",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:readline",
  "node:stream",
  "node:tls",
  "node:url",
  "node:util",
  "node:vm",
  "node:worker_threads",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads"
]);
async function checkServerActionGraphAsync(serverDir) {
  const root = resolve(serverDir);
  const entry = join(root, "src", "actions.ts");
  if (!existsSync(entry)) {
    return null;
  }
  const stack = [entry];
  const seen = new Set;
  while (stack.length > 0) {
    const filePath = stack.pop();
    const canonical = resolve(filePath);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    const content = await Bun.file(canonical).text();
    const sourceViolation = checkServerActionSource(content);
    if (sourceViolation !== null) {
      return { filePath: canonical, reason: sourceViolation };
    }
    for (const ref of collectImportReferences(stripComments(content))) {
      if (isHostModuleSpecifier(ref.specifier)) {
        return { filePath: canonical, reason: REASON_HOST_MODULE_IMPORT };
      }
      if (ref.typeOnly) {
        continue;
      }
      if (!isRelativeSpecifier(ref.specifier)) {
        continue;
      }
      const target = resolveImport(canonical, ref.specifier);
      if (target === null) {
        continue;
      }
      if (!isWithin(root, target)) {
        continue;
      }
      if (isPrivilegedImplementationPath(target)) {
        return {
          filePath: canonical,
          reason: REASON_IMPORT_PRIVILEGED_IMPLEMENTATION
        };
      }
      stack.push(target);
    }
  }
  return null;
}
var CALL_EXPRESSION = /[A-Za-z0-9_$)\]]\s*\(/;
var EXECUTABLE_KEYWORD = /\b(throw|await|delete|yield|for|while|if|switch|do|new)\b/;
var EMPTY_ACTIONS_EXPORT = /\bexport\s+const\s+Actions\s*(?::\s*[^=;]+)?=\s*\{\s*\}\s*(?:satisfies\s+[^;]+)?;?/;
function analyzeServerActionsShape(content) {
  const stripped = stripCommentsAndStrings(content);
  if (!EMPTY_ACTIONS_EXPORT.test(stripped)) {
    return { clientOnly: false, reason: "module exports server actions" };
  }
  for (const ref of collectImportReferences(stripComments(content))) {
    if (!ref.typeOnly) {
      return {
        clientOnly: false,
        reason: "module imports runtime (value) modules"
      };
    }
  }
  if (/`/.test(stripComments(content))) {
    return { clientOnly: false, reason: "module uses template literals" };
  }
  if (CALL_EXPRESSION.test(stripped)) {
    return { clientOnly: false, reason: "module contains a function call" };
  }
  if (EXECUTABLE_KEYWORD.test(stripped)) {
    return {
      clientOnly: false,
      reason: "module contains top-level executable statements"
    };
  }
  return { clientOnly: true, reason: null };
}
function checkServerActionSource(content) {
  const stripped = stripCommentsAndStrings(content);
  if (/\bprocess\b/.test(stripped)) {
    return REASON_PROCESS_GLOBAL;
  }
  if (/\bBun\b/.test(stripped)) {
    return REASON_BUN_GLOBAL;
  }
  if (/\brequire\s*\(/.test(stripped)) {
    return REASON_REQUIRE_CALL;
  }
  if (/\bimport\s*\(/.test(stripped)) {
    return REASON_DYNAMIC_IMPORT;
  }
  if (/\b(spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(/.test(stripped)) {
    return REASON_SUBPROCESS_API;
  }
  if (/\b(eval|Function)\s*\(/.test(stripped)) {
    return REASON_EVAL_API;
  }
  return null;
}
function collectImportReferences(source) {
  const refs = [];
  const importFrom = /\bimport\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importFrom.exec(source)) !== null) {
    refs.push({
      specifier: match[2],
      typeOnly: match[1] !== undefined
    });
  }
  const exportFrom = /\bexport\s+(type\s+)?(?:[^'";]*?\s+from\s+)["']([^"']+)["']/g;
  while ((match = exportFrom.exec(source)) !== null) {
    refs.push({
      specifier: match[2],
      typeOnly: match[1] !== undefined
    });
  }
  return refs;
}
function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}
function isHostModuleSpecifier(specifier) {
  return specifier.startsWith("node:") || specifier.startsWith("bun:") || HOST_MODULES.has(specifier);
}
function isPrivilegedImplementationPath(path) {
  const normalized = normalize(path);
  return basename(normalized) === "privileged.ts";
}
function resolveImport(importerPath, specifier) {
  const base = resolve(dirname(importerPath), specifier);
  const candidates = [];
  if (extname(base) !== "") {
    candidates.push(base);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"));
  }
  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile()) {
        return resolve(candidate);
      }
    } catch {
      continue;
    }
  }
  return null;
}
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || !rel.startsWith("..") && !rel.startsWith("/");
}
function stripComments(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < n && source[i] !== `
`) {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === `
` ? `
` : " ");
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}
function stripCommentsAndStrings(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      out.push("  ");
      i += 2;
      while (i < n && source[i] !== `
`) {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === `
` ? `
` : " ");
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out.push(" ");
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(source[i] === `
` ? `
` : " ");
        i++;
      }
      if (i < n) {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "`") {
      out.push(" ");
      i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (depth === 0 && ch === "`")
          break;
        if (ch === "\\" && i + 1 < n) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (ch === "$" && source[i + 1] === "{") {
          depth++;
          out.push("${");
          i += 2;
          continue;
        }
        if (depth > 0 && ch === "}") {
          depth--;
          out.push("}");
          i++;
          continue;
        }
        if (depth > 0) {
          out.push(ch);
          i++;
          continue;
        }
        out.push(ch === `
` ? `
` : " ");
        i++;
      }
      if (i < n) {
        out.push(" ");
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

// src/validate-server-actions-cli.ts
function arg(name) {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) {
      return raw.slice(flag.length);
    }
  }
  return;
}
var serverDir = arg("server-dir");
if (!serverDir) {
  process.stderr.write(`usage: validate-server-actions.js --server-dir=<path>
`);
  process.exit(2);
}
async function main() {
  try {
    const dirStat = await stat(serverDir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      process.stdout.write(JSON.stringify({
        ok: true,
        files: 0,
        clientOnly: true,
        hasServerActions: false
      }) + `
`);
      return 0;
    }
    const violation = await checkServerActionGraphAsync(serverDir);
    if (violation !== null) {
      process.stderr.write(`${relative2(serverDir, violation.filePath)}: ${violation.reason}
`);
      return 1;
    }
    const actionsSource = await Bun.file(join2(serverDir, "src", "actions.ts")).text().catch(() => "");
    const shape = analyzeServerActionsShape(actionsSource);
    if (shape.clientOnly) {
      const privilegedStat = await stat(join2(serverDir, "src", "privileged.ts")).catch(() => null);
      if (privilegedStat?.isFile()) {
        process.stderr.write("client-only web artifact (no server actions) must not include " + "server/src/privileged.ts; remove it, or add a server action to " + `make this a server-backed artifact.
`);
        return 1;
      }
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      clientOnly: shape.clientOnly,
      hasServerActions: !shape.clientOnly
    }) + `
`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`validate-server-actions fatal: ${message}
`);
    return 2;
  }
}
main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`validate-server-actions fatal: ${String(err)}
`);
  process.exit(2);
});
