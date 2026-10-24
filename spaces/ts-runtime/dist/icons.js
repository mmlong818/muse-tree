// @bun
// icons/cli.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { gunzipSync } from "zlib";

// sdk/src/icons/types.ts
function iconLabel(props) {
  if (props.decorative === true || props.label == null)
    return null;
  if (props.label.trim().length === 0)
    throw new Error("A meaningful icon needs a non-empty label");
  return props.label;
}
function iconSize(size = 24) {
  if (![12, 16, 20, 24, 32, 40, 48].includes(size))
    throw new Error("Unsupported icon size");
  return size;
}

// sdk/src/icons/static.ts
function escape(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function renderIconSvg(props) {
  const label = iconLabel(props);
  const size = iconSize(props.size);
  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    `viewBox="${escape(props.glyph.viewBox)}"`,
    `width="${size}"`,
    `height="${size}"`,
    'fill="none"',
    'focusable="false"',
    label == null ? 'aria-hidden="true"' : `role="img" aria-label="${escape(label)}"`
  ];
  if (props.className != null)
    attrs.push(`class="${escape(props.className)}"`);
  const paths = props.glyph.paths.map((path) => {
    const attrs = Object.entries(path).filter(([, value]) => value != null).map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${escape(String(value))}"`);
    return `<path ${attrs.join(" ")}/>`;
  });
  return `<svg ${attrs.join(" ")}>${paths.join("")}</svg>`;
}

// icons/cli.ts
var ICONS_DIR = join(import.meta.dir, "..", "..", "icons");
var MODULE_SPECIFIER = "@space/icons";
var GENERATED = join("client", ".generated", "icons.ts");
var WEIGHTS = [300, 400, 500, 600, 700];
var SIZES = [12, 16, 20, 24, 32, 40, 48];
var DEFAULT_WEIGHT = 400;
var IMPORT_NAME = /^(Brand)?([A-Z][A-Za-z0-9]*?)(?:Wght(300|400|500|600|700))?(Icon|Glyph)$/;

class IconSet {
  icons;
  byKey = new Map;
  aliasByKey = new Map;
  byModule = new Map;
  constructor() {
    const source = JSON.parse(gunzipSync(readFileSync(join(ICONS_DIR, "icons.json.gz"))).toString("utf8"));
    const aliases = JSON.parse(readFileSync(join(ICONS_DIR, "aliases.json"), "utf8")).aliases;
    this.icons = source.icons;
    for (const icon of this.icons) {
      this.byModule.set(icon.module, icon);
      push(this.byKey, key(icon.module), icon);
    }
    for (const [alias, target] of Object.entries(aliases)) {
      const targets = this.aliasByKey.get(key(alias)) ?? [];
      if (!targets.includes(target))
        targets.push(target);
      this.aliasByKey.set(key(alias), targets);
    }
  }
  lookup(name, brand, spell) {
    const wanted = key(name);
    const exact = this.byKey.get(wanted) ?? [];
    const aliased = (this.aliasByKey.get(wanted) ?? []).map((module) => this.byModule.get(module));
    const matches = exact.length > 0 ? exact : aliased;
    if (matches.length === 1) {
      const icon = matches[0];
      if (icon.brand && !brand) {
        return { error: `"${icon.module}" is a logo; use ${spell({ ...icon, brand: true })} if you mean the logo.` };
      }
      if (!icon.brand && brand)
        return { error: `"${icon.module}" is not a logo; use ${spell(icon)}.` };
      return { icon, via: exact.length > 0 ? "name" : "alias" };
    }
    const candidates = matches.length > 1 ? matches : this.closest(name, brand, 3);
    const listed = candidates.map((icon) => `${spell(icon)} (${icon.description})`).join(", ");
    const what = matches.length > 1 ? "matches more than one icon" : "matches no icon";
    return { error: `"${name}" ${what}.${listed ? ` Closest: ${listed}.` : ""}` };
  }
  find(name) {
    const strict = this.lookup(name, false, (icon) => icon.module);
    if ("icon" in strict)
      return strict.icon;
    return this.byKey.get(key(name))?.[0] ?? this.byModule.get(name);
  }
  closest(query, brand, limit) {
    const all = this.ranked(query, brand, true);
    return (all.length > 0 ? all : this.ranked(query, brand, false)).slice(0, limit);
  }
  ranked(query, brand, everyWord) {
    const words = words_(query);
    return this.icons.filter((icon) => icon.brand === brand).map((icon) => {
      const tokens = icon.module.split("-");
      const haystack = [icon.module, icon.description, ...icon.keywords].join(" ").toLowerCase();
      const score = words.reduce((total, word) => total + (tokens.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0);
      return { icon, score };
    }).filter(({ score }) => score > 0 && (!everyWord || score >= words.length)).sort((a, b) => b.score - a.score || a.icon.module.length - b.icon.module.length || a.icon.module.localeCompare(b.icon.module)).map(({ icon }) => icon);
  }
}
function push(map, k, value) {
  const list = map.get(k) ?? [];
  list.push(value);
  map.set(k, list);
}
function key(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function words_(name) {
  return name.replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function pascal(module) {
  return module.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}
function flag(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
function weightsOf(icon) {
  return Object.keys(icon.variants).map(Number).sort();
}
function glyphOf(icon, weight) {
  const variant = icon.variants[String(weight)];
  return variant == null ? undefined : { name: icon.name, weight, viewBox: "0 0 24 24", paths: variant.paths };
}
function sourceFiles(dir) {
  if (!existsSync(dir))
    return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules")
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
      out.push(path);
  }
  return out;
}
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function scanRequests(space, errors) {
  const requests = [];
  const statement = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s+from\s+["']@space\/icons["']/g;
  for (const path of sourceFiles(join(space, "client", "src"))) {
    const file = relative(space, path);
    const text = stripComments(readFileSync(path, "utf8"));
    for (const match of text.matchAll(statement)) {
      const clause = match[1].trim();
      const braces = /^\{([\s\S]*)\}$/.exec(clause);
      if (braces == null) {
        errors.push(`${file}: import icons by name, e.g. import { HomeIcon } from "${MODULE_SPECIFIER}".`);
        continue;
      }
      for (const raw of braces[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name)
          requests.push({ name, file });
      }
    }
  }
  return requests;
}
function generatedModule(set, requests, errors) {
  const glyphs = new Map;
  const exports = [];
  const seen = new Set;
  for (const { name, file } of requests) {
    if (seen.has(name))
      continue;
    seen.add(name);
    const parts = IMPORT_NAME.exec(name);
    if (parts == null) {
      const hint = name === "Icon" || name === "createIcon" ? ` Import ${name} from "@hatch/space-sdk/icons".` : "";
      errors.push(`${file}: ${name} is not an icon name (expected e.g. HomeIcon, HomeWght600Icon, HomeGlyph).${hint}`);
      continue;
    }
    const [, brand, core, weightText, kind] = parts;
    const suffix = `${weightText == null ? "" : `Wght${weightText}`}${kind}`;
    const found = set.lookup(core, brand != null, (icon) => `${icon.brand ? "Brand" : ""}${pascal(icon.module)}${suffix}`);
    if ("error" in found) {
      errors.push(`${file}: ${name}: ${found.error}`);
      continue;
    }
    const weight = weightText == null ? DEFAULT_WEIGHT : Number(weightText);
    if (glyphOf(found.icon, weight) == null) {
      errors.push(`${file}: ${name}: "${found.icon.module}" has weights ${weightsOf(found.icon).join(", ")}.`);
      continue;
    }
    const id = `${found.icon.module.replaceAll("-", "_")}_${weight}`;
    glyphs.set(id, { icon: found.icon, weight });
    exports.push(kind === "Glyph" ? `export const ${name} = ${id};
` : `export function ${name}(props: IconAppearance & IconAccessibility): ReactElement {
  return Icon({ ...props, glyph: ${id} });
}
`);
  }
  const header = [
    `/** Generated by the artifact build from this artifact's "@space/icons" imports. */
`,
    `// Do not edit: import icons by name from "@space/icons" and rebuild.
`
  ];
  if (exports.length === 0)
    return `${header.join("")}export {};
`;
  const components = exports.some((line) => line.startsWith("export function"));
  const lines = [
    ...header,
    ...components ? [
      `import type { ReactElement } from "react";
`,
      `import { Icon, type IconAccessibility, type IconAppearance, type IconGlyph } from "@hatch/space-sdk/icons";

`
    ] : [`import type { IconGlyph } from "@hatch/space-sdk/icons";

`]
  ];
  for (const [id, { icon, weight }] of glyphs) {
    lines.push(`const ${id}: IconGlyph<${JSON.stringify(icon.name)}, ${weight}> = ${JSON.stringify(glyphOf(icon, weight))};
`);
  }
  lines.push(`
`, ...exports);
  return lines.join("");
}
function resolve(args) {
  const space = flag(args, "space");
  if (space == null)
    throw new Error("resolve needs --space=<artifact dir>");
  const out = join(space, GENERATED);
  const errors = [];
  const requests = scanRequests(space, errors);
  const source = requests.length === 0 && errors.length === 0 ? `/** Generated by the artifact build. This artifact imports no icons. */
export {};
` : generatedModule(new IconSet, requests, errors);
  if (errors.length > 0) {
    rmSync(out, { force: true });
    throw new Error(`icons: ${errors.length} import${errors.length === 1 ? "" : "s"} from "${MODULE_SPECIFIER}" did not resolve:
` + errors.map((error) => `- ${error}`).join(`
`) + `
Import one of the closest names, or describe the icon differently.`);
  }
  mkdirSync(join(space, "client", ".generated"), { recursive: true });
  writeFileSync(out, source);
  process.stdout.write(`icons: resolved ${new Set(requests.map((r) => r.name)).size} icon import(s)
`);
}
function attributes(text) {
  const attrs = new Map;
  for (const match of text.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs.set(match[1].toLowerCase(), match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}
function escapeAttr(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function fill(args) {
  const html = flag(args, "html");
  if (html == null)
    throw new Error("fill needs --html=<file>");
  const text = readFileSync(html, "utf8");
  const placeholder = /<svg\b([^>]*\bdata-icon\s*=[^>]*?)\s*(?:\/>|>\s*<\/svg>)/gi;
  if (!/\bdata-icon\s*=/i.test(text))
    return;
  const set = new IconSet;
  const errors = [];
  let count = 0;
  const filled = text.replace(placeholder, (whole, attrText) => {
    const attrs = attributes(attrText);
    const raw = attrs.get("data-icon") ?? "";
    const brand = /^brand[-_:\s]/i.test(raw);
    const name = brand ? raw.replace(/^brand[-_:\s]+/i, "") : raw;
    const found = set.lookup(name, brand, (icon) => `data-icon="${icon.brand ? "brand-" : ""}${icon.module}"`);
    if ("error" in found) {
      errors.push(`data-icon="${raw}": ${found.error}`);
      return whole;
    }
    const weight = Number(attrs.get("data-weight") ?? DEFAULT_WEIGHT);
    const glyph = WEIGHTS.includes(weight) ? glyphOf(found.icon, weight) : undefined;
    if (glyph == null) {
      errors.push(`data-icon="${raw}": weight ${attrs.get("data-weight")} is not available (${weightsOf(found.icon).join(", ")}).`);
      return whole;
    }
    const size = Number(attrs.get("width") ?? attrs.get("height") ?? 24);
    if (!SIZES.includes(size)) {
      errors.push(`data-icon="${raw}": size ${size} is not one of ${SIZES.join(", ")}.`);
      return whole;
    }
    const label = attrs.get("aria-label")?.trim();
    const className = attrs.get("class");
    const svg = label ? renderIconSvg({ glyph, size, label, ...className ? { className } : {} }) : renderIconSvg({ glyph, size, decorative: true, ...className ? { className } : {} });
    const kept = ["id", "style"].filter((attr) => attrs.has(attr)).map((attr) => ` ${attr}="${escapeAttr(attrs.get(attr))}"`).join("");
    count += 1;
    return svg.replace("<svg ", `<svg data-icon="${escapeAttr(raw)}"${kept} `);
  });
  if (errors.length > 0) {
    throw new Error(`icons: ${errors.length} icon placeholder${errors.length === 1 ? "" : "s"} did not resolve:
` + errors.map((error) => `- ${error}`).join(`
`) + `
Use one of the closest names, or describe the icon differently.`);
  }
  writeFileSync(html, filled);
  process.stdout.write(`icons: filled ${count} icon placeholder(s)
`);
}
function line(icon, via) {
  const from = via == null ? "" : ` (alias ${via})`;
  const brand = icon.brand ? " [logo]" : "";
  return `  ${pascal(icon.module)}Icon${from}${brand}	[${weightsOf(icon).join(",")}]	${icon.description}
`;
}
function search(args) {
  const queries = args.filter((arg) => !arg.startsWith("--"));
  const limit = Number(flag(args, "limit") ?? 5);
  if (queries.length === 0)
    throw new Error("search needs at least one query");
  const set = new IconSet;
  for (const query of queries) {
    process.stdout.write(`${query}:
`);
    const spell = (icon) => icon.module;
    const direct = set.lookup(query, false, spell);
    const brandDirect = "icon" in direct ? undefined : set.lookup(query, true, spell);
    const hit = "icon" in direct ? direct : brandDirect != null && ("icon" in brandDirect) ? brandDirect : undefined;
    if (hit != null)
      process.stdout.write(line(hit.icon, hit.via === "alias" ? query : undefined));
    const rest = set.closest(query, false, limit).filter((icon) => icon !== hit?.icon);
    for (const icon of rest.slice(0, hit == null ? limit : limit - 1))
      process.stdout.write(line(icon));
    if (hit == null && rest.length === 0)
      process.stdout.write(`  no matching icons
`);
  }
}
function svg(args) {
  const wanted = args.filter((arg) => !arg.startsWith("--"));
  if (wanted.length === 0)
    throw new Error("svg needs an icon name");
  const label = flag(args, "label");
  if (label != null && wanted.length > 1)
    throw new Error("--label applies to a single icon");
  const set = new IconSet;
  const weight = Number(flag(args, "weight") ?? DEFAULT_WEIGHT);
  const size = Number(flag(args, "size") ?? 24);
  const unknown = [];
  for (const name of wanted) {
    const icon = set.find(name);
    if (icon == null) {
      unknown.push(name);
      continue;
    }
    const glyph = glyphOf(icon, weight);
    if (glyph == null)
      throw new Error(`${icon.module} has weights ${weightsOf(icon).join(", ")}`);
    const markup = label == null ? renderIconSvg({ glyph, size, decorative: true }) : renderIconSvg({ glyph, size, label });
    process.stdout.write(wanted.length > 1 ? `<!-- ${name} -->
${markup}
` : `${markup}
`);
  }
  if (unknown.length > 0)
    throw new Error(`unknown icon(s): ${unknown.join(", ")}; run search with these names`);
}
var [command, ...rest] = process.argv.slice(2);
try {
  if (command === "resolve")
    resolve(rest);
  else if (command === "fill")
    fill(rest);
  else if (command === "search")
    search(rest);
  else if (command === "svg")
    svg(rest);
  else {
    throw new Error("usage: icons.js resolve --space=<dir> | fill --html=<file> | search <query>... | svg <name>... [--weight=400] [--size=24] [--label=<text>]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
}
