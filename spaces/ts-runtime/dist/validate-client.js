// @bun
// src/validate-client-cli.ts
import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";

// src/validate-client.ts
var REASON_QUERY_CLIENT_IMPORT = 'value-importing `QueryClient` from "@tanstack/react-query" is not allowed in web artifact client code. ' + 'Use the SDK\'s shared instance: `import { spaceQueryClient } from "@hatch/space-sdk/client"`. ' + "QueryClient defaults (cache lifetime, retry policy, refetch behavior) are tuned in the SDK so they stay consistent across every web artifact.";
var REASON_QUERY_CLIENT_STAR_IMPORT = 'star-importing "@tanstack/react-query" is not allowed because it exposes `QueryClient` via the namespace. ' + "Import the named hooks/components you actually need (e.g. `useQuery`, `useMutation`, `QueryClientProvider`).";
var REASON_QUERY_CLIENT_NEW = "constructing a new `QueryClient(...)` in web artifact client code is not allowed. " + 'Use the SDK\'s shared instance: `import { spaceQueryClient } from "@hatch/space-sdk/client"`.';
var REASON_FROM_CHAR_CODE_SPREAD = "spreading a byte array into `String.fromCharCode(...)` is not allowed in web artifact client code: " + "it throws `RangeError: Maximum call stack size exceeded` on multi-megabyte inputs (any phone photo). " + "Encode binary data with the SDK instead: " + '`import { fileToBase64, bytesToBase64 } from "@hatch/space-sdk/client"`.';
function checkClientSource(content) {
  const commentsStripped = stripComments(content);
  const importViolation = findForbiddenQueryClientImport(commentsStripped);
  if (importViolation !== null)
    return importViolation;
  const fullyStripped = stripCommentsAndStrings(content);
  const newViolation = findForbiddenQueryClientConstruction(fullyStripped);
  if (newViolation !== null)
    return newViolation;
  const spreadViolation = findForbiddenFromCharCodeSpread(fullyStripped);
  if (spreadViolation !== null)
    return spreadViolation;
  return null;
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
function findForbiddenQueryClientImport(stripped) {
  const importStatement = /\bimport\s+(?:(type)\s+)?(?:\*\s+as\s+\w+|\{([^}]*)\}|\w+(?:\s*,\s*\{([^}]*)\})?)\s+from\s+["']@tanstack\/react-query["']/g;
  let match;
  while ((match = importStatement.exec(stripped)) !== null) {
    const fullMatch = match[0];
    const isTypeOnly = match[1] !== undefined;
    if (isTypeOnly)
      continue;
    if (/\*\s+as\s+\w+/.test(fullMatch)) {
      return REASON_QUERY_CLIENT_STAR_IMPORT;
    }
    const namedGroup = match[2] ?? match[3];
    if (namedGroup === undefined)
      continue;
    if (importsValueQueryClient(namedGroup)) {
      return REASON_QUERY_CLIENT_IMPORT;
    }
  }
  return null;
}
function importsValueQueryClient(namedImportList) {
  for (const raw of namedImportList.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0)
      continue;
    if (/^type\s+/.test(entry))
      continue;
    const baseName = entry.split(/\s+as\s+/)[0].trim();
    if (baseName === "QueryClient")
      return true;
  }
  return false;
}
function findForbiddenQueryClientConstruction(stripped) {
  if (/\bnew\s+QueryClient\s*\(/.test(stripped)) {
    return REASON_QUERY_CLIENT_NEW;
  }
  return null;
}
function findForbiddenFromCharCodeSpread(stripped) {
  if (/\bString\s*\.\s*fromCharCode\s*\(\s*\.\.\./.test(stripped)) {
    return REASON_FROM_CHAR_CODE_SPREAD;
  }
  return null;
}

// src/validate-client-cli.ts
function arg(name) {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) {
      return raw.slice(flag.length);
    }
  }
  return;
}
var clientDir = arg("client-dir");
if (!clientDir) {
  process.stderr.write(`usage: validate-client.js --client-dir=<path>
`);
  process.exit(2);
}
async function isNotFound(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
async function* walkTsSources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (await isNotFound(err))
      return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist")
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsSources(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      yield full;
    }
  }
}
async function main() {
  try {
    const dirStat = await stat(clientDir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      process.stdout.write(JSON.stringify({ ok: true, files: 0 }) + `
`);
      return 0;
    }
    let scanned = 0;
    for await (const filePath of walkTsSources(clientDir)) {
      const content = await readFile(filePath, "utf8");
      const reason = checkClientSource(content);
      if (reason !== null) {
        const rel = relative(clientDir, filePath);
        process.stderr.write(`${rel}: ${reason}
`);
        return 1;
      }
      scanned++;
    }
    process.stdout.write(JSON.stringify({ ok: true, files: scanned }) + `
`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`validate-client fatal: ${message}
`);
    return 2;
  }
}
main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`validate-client fatal: ${String(err)}
`);
  process.exit(2);
});
