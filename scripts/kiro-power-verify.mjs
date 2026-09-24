#!/usr/bin/env node
/**
 * kiro-power-verify: validate Kiro powers in the Agent Plugins format.
 *
 * Ships INTO the public meko-skills repo (copied verbatim by the publish
 * generator) and also runs in source CI, so it uses Node built-ins only.
 *
 * The rules mirror Kiro's own loader (AgentPluginLoader in Kiro IDE 1.0.437 and
 * Kiro Agent Server 0.66.8), which silently drops what it rejects: a bad
 * mcp.json disables every server in it, and a bad SKILL.md is skipped. A power
 * that "installs" can therefore still ship no tools. On top of the loader
 * rules, this enforces:
 *   - the fields the kiro.dev/powers/submit form requires (version,
 *     description, author.name, keywords, license);
 *   - Agent Plugins spec 7.2.1: no credentials in headers and no placeholder
 *     expansion in url or headers. Kiro sends `${VAR}` in a plugin-format
 *     header literally, so a placeholder is always a bug;
 *   - a User-Agent header on remote servers, which the Meko Cloud WAF requires.
 *
 * Usage (from the repo root): node scripts/kiro-power-verify.mjs [powerDir ...]
 * With no arguments, every directory under ./powers is verified.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_SCHEMA_RE =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/plugin\.schema\.json$/;
const MCP_SCHEMA_RE =
  /^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/mcp\.schema\.json$/;
const SCHEMA_VERSION_RE = /\/schemas\/([\d.]+)\//;
const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;

// Fields Kiro reads from plugin.json. Anything else is ignored with a warning,
// which in a published power only hides a typo.
const PLUGIN_FIELDS = new Set([
  "$schema",
  "name",
  "displayName",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);
const REMOTE_FIELDS = new Set(["type", "url", "headers"]);
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
]);

function readJsonObject(path, label, errors) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${label} must be a JSON object`);
    return null;
  }
  return parsed;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkPluginName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    PLUGIN_NAME_RE.test(name) &&
    !name.includes("--") &&
    !name.includes("..")
  );
}

export function isValidSkillName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    SKILL_NAME_RE.test(name) &&
    !name.includes("--")
  );
}

function verifyManifest(dir, errors) {
  const path = join(dir, "plugin.json");
  if (!existsSync(path)) {
    errors.push("plugin.json is missing");
    return null;
  }
  const manifest = readJsonObject(path, "plugin.json", errors);
  if (!manifest) return null;

  if (!PLUGIN_SCHEMA_RE.test(manifest.$schema ?? "")) {
    errors.push(`plugin.json $schema is unsupported: ${manifest.$schema}`);
  }
  if (!checkPluginName(manifest.name)) {
    errors.push(
      `plugin.json name must be 1-64 chars of [a-z0-9.-], start and end alphanumeric, without "--" or "..": ${manifest.name}`,
    );
  }
  for (const key of Object.keys(manifest)) {
    if (!PLUGIN_FIELDS.has(key)) {
      errors.push(`plugin.json field "${key}" is not read by Kiro`);
    }
  }
  if (!SEMVER_RE.test(manifest.version ?? "")) {
    errors.push(`plugin.json version must be a semantic version: ${manifest.version}`);
  }
  if (!isNonEmptyString(manifest.description)) {
    errors.push("plugin.json description is required");
  }
  const author = manifest.author;
  if (!author || typeof author !== "object" || Array.isArray(author)) {
    errors.push("plugin.json author must be an object");
  } else {
    for (const key of Object.keys(author)) {
      // Kiro drops the whole author object when it sees an unknown key.
      if (!AUTHOR_FIELDS.has(key)) errors.push(`plugin.json author field "${key}" makes Kiro ignore the author`);
    }
    if (!isNonEmptyString(author.name)) errors.push("plugin.json author.name is required");
  }
  if (
    !Array.isArray(manifest.keywords) ||
    manifest.keywords.length === 0 ||
    !manifest.keywords.every(isNonEmptyString)
  ) {
    errors.push("plugin.json keywords must be a non-empty array of strings");
  }
  if (!isNonEmptyString(manifest.license)) {
    errors.push("plugin.json license is required by the kiro.dev/powers/submit form");
  }
  if (
    manifest.extensions !== undefined &&
    (!manifest.extensions || typeof manifest.extensions !== "object" || Array.isArray(manifest.extensions))
  ) {
    errors.push("plugin.json extensions must be an object");
  }
  return manifest;
}

function verifyUrl(url, server, errors) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push(`mcp.json server "${server}" url is not a valid URL: ${url}`);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`mcp.json server "${server}" url must use http or https`);
  }
  if (parsed.username || parsed.password) {
    errors.push(`mcp.json server "${server}" url must not contain user info`);
  }
  if (parsed.hash) {
    errors.push(`mcp.json server "${server}" url must not contain a fragment`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && parsed.protocol !== "https:") {
    errors.push(`mcp.json server "${server}" url must use https for a non-loopback host`);
  }
}

function verifyRemoteServer(name, entry, errors) {
  for (const key of Object.keys(entry)) {
    if (!REMOTE_FIELDS.has(key)) {
      errors.push(`mcp.json server "${name}" field "${key}" is not allowed for ${entry.type}; Kiro skips the server`);
    }
  }
  if (!isNonEmptyString(entry.url)) {
    errors.push(`mcp.json server "${name}" needs a url`);
  } else {
    verifyUrl(entry.url, name, errors);
    if (entry.url.includes("${")) {
      errors.push(`mcp.json server "${name}" url contains a placeholder; Kiro sends it literally`);
    }
  }
  const headers = entry.headers;
  if (headers === undefined) {
    errors.push(`mcp.json server "${name}" must set a User-Agent header (Meko Cloud WAF)`);
    return;
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    errors.push(`mcp.json server "${name}" headers must be an object`);
    return;
  }
  const seen = new Set();
  for (const [header, value] of Object.entries(headers)) {
    const lower = header.toLowerCase();
    if (typeof value !== "string") {
      errors.push(`mcp.json server "${name}" header "${header}" must be a string`);
    }
    if (seen.has(lower)) {
      errors.push(`mcp.json server "${name}" repeats header "${header}" (case-insensitive); Kiro skips the server`);
    }
    seen.add(lower);
    if (CREDENTIAL_HEADERS.has(lower)) {
      errors.push(`mcp.json server "${name}" header "${header}" carries a credential; Agent Plugins forbids secrets in headers`);
    }
    if (typeof value === "string" && value.includes("${")) {
      errors.push(`mcp.json server "${name}" header "${header}" contains a placeholder; Kiro sends it literally`);
    }
  }
  if (!seen.has("user-agent")) {
    errors.push(`mcp.json server "${name}" must set a User-Agent header (Meko Cloud WAF)`);
  }
}

function verifyStdioServer(name, entry, dir, errors) {
  for (const key of Object.keys(entry)) {
    if (!STDIO_FIELDS.has(key)) {
      errors.push(`mcp.json server "${name}" field "${key}" is not allowed for stdio; Kiro skips the server`);
    }
  }
  const command = entry.command;
  if (!isNonEmptyString(command)) {
    errors.push(`mcp.json server "${name}" needs a command`);
  } else if (command.startsWith("./")) {
    const target = resolve(dir, command);
    if (target !== resolve(dir) && !target.startsWith(resolve(dir) + sep)) {
      errors.push(`mcp.json server "${name}" command escapes the power directory`);
    }
  } else if (command.includes("/") || command.includes("\\") || command.startsWith("..")) {
    errors.push(`mcp.json server "${name}" command must be a bare name or start with ./`);
  }
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) {
    errors.push(`mcp.json server "${name}" args must be an array of strings`);
  }
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
      errors.push(`mcp.json server "${name}" env must be an object`);
    } else {
      if ("PLUGIN_ROOT" in entry.env || "PLUGIN_DATA" in entry.env) {
        errors.push(`mcp.json server "${name}" env must not set PLUGIN_ROOT or PLUGIN_DATA`);
      }
      for (const [key, value] of Object.entries(entry.env)) {
        if (typeof value !== "string") errors.push(`mcp.json server "${name}" env "${key}" must be a string`);
      }
    }
  }
  if (entry.cwd !== undefined) {
    const cwd = entry.cwd;
    const validForm =
      typeof cwd === "string" &&
      !cwd.includes("..") &&
      (cwd.startsWith("./") ||
        cwd === "${PLUGIN_ROOT}" ||
        cwd.startsWith("${PLUGIN_ROOT}/") ||
        cwd === "${PLUGIN_DATA}" ||
        cwd.startsWith("${PLUGIN_DATA}/"));
    if (!validForm) {
      errors.push(`mcp.json server "${name}" cwd must start with ./, \${PLUGIN_ROOT}, or \${PLUGIN_DATA}`);
    }
  }
}

function verifyMcpConfig(dir, manifest, errors) {
  const path = join(dir, "mcp.json");
  if (!existsSync(path)) return;
  if (!statSync(path).isFile()) {
    errors.push("mcp.json must be a regular file");
    return;
  }
  const config = readJsonObject(path, "mcp.json", errors);
  if (!config) return;
  if (!MCP_SCHEMA_RE.test(config.$schema ?? "")) {
    errors.push(`mcp.json $schema is unsupported: ${config.$schema}`);
  } else if (manifest && PLUGIN_SCHEMA_RE.test(manifest.$schema ?? "")) {
    const mcpVersion = SCHEMA_VERSION_RE.exec(config.$schema)?.[1];
    const pluginVersion = SCHEMA_VERSION_RE.exec(manifest.$schema)?.[1];
    if (mcpVersion !== pluginVersion) {
      errors.push(
        `mcp.json targets Agent Plugins ${mcpVersion} but plugin.json targets ${pluginVersion}; Kiro loads no servers`,
      );
    }
  }
  for (const key of Object.keys(config)) {
    if (key !== "$schema" && key !== "mcpServers") {
      errors.push(`mcp.json field "${key}" is not allowed; Kiro loads no servers`);
    }
  }
  const servers = config.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    errors.push('mcp.json needs an "mcpServers" object');
    return;
  }
  if (Object.keys(servers).length === 0) {
    errors.push("mcp.json declares no servers");
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`mcp.json server "${name}" must be an object`);
      continue;
    }
    switch (entry.type) {
      case "streamable-http":
      case "sse":
        verifyRemoteServer(name, entry, errors);
        break;
      case "stdio":
        verifyStdioServer(name, entry, dir, errors);
        break;
      default:
        errors.push(
          `mcp.json server "${name}" type must be stdio, streamable-http, or sse (got ${JSON.stringify(entry.type)})`,
        );
    }
  }
}

/**
 * Read top-level scalar keys from YAML frontmatter. Handles plain, quoted, and
 * folded/literal block scalars, which covers every SKILL.md this repo ships.
 * @param {string} block frontmatter body without the --- fences
 * @returns {Record<string, string>}
 */
export function parseFrontmatterScalars(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rawValue] = m;
    let value = rawValue.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function verifySkills(dir, errors) {
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir)) return [];
  if (!statSync(skillsDir).isDirectory()) {
    errors.push("skills must be a directory");
    return [];
  }
  const names = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const label = `skills/${entry.name}/SKILL.md`;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) {
      errors.push(`skills/${entry.name} has no SKILL.md; Kiro ignores it`);
      continue;
    }
    if (!isValidSkillName(entry.name)) {
      errors.push(`${label}: directory name is not a valid skill name; Kiro skips it`);
    }
    const text = readFileSync(skillPath, "utf8");
    const fm = FRONTMATTER_BLOCK.exec(text);
    if (!fm) {
      errors.push(`${label}: frontmatter must start on line 1; Kiro skips the skill`);
      continue;
    }
    const fields = parseFrontmatterScalars(fm[1]);
    if (!fields.name || !fields.description) {
      errors.push(`${label}: frontmatter needs name and description`);
      continue;
    }
    if (!isValidSkillName(fields.name)) {
      errors.push(`${label}: frontmatter name is not a valid skill name: ${fields.name}`);
    }
    if (fields.name !== entry.name) {
      errors.push(`${label}: frontmatter name "${fields.name}" must match its directory`);
    }
    if (fields.description.length > 1024) {
      errors.push(`${label}: description is ${fields.description.length} chars; the limit is 1024`);
    }
    names.push(entry.name);
  }
  return names;
}

function listMarkdown(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(path, acc);
    else if (entry.isFile() && entry.name.endsWith(".md")) acc.push(path);
  }
  return acc;
}

function verifyKiroExtensions(dir, errors) {
  const kiroDir = join(dir, "dev.kiro");
  if (!existsSync(join(kiroDir, "INSTRUCTIONS.md"))) {
    errors.push("dev.kiro/INSTRUCTIONS.md is missing; Kiro shows no instructions on activation");
  }
  const steeringDir = join(kiroDir, "steering");
  if (existsSync(steeringDir)) {
    const md = readdirSync(steeringDir).filter((f) => f.endsWith(".md"));
    if (md.length === 0) errors.push("dev.kiro/steering contains no .md files");
  }
}

function verifyLinks(dir, errors) {
  for (const md of listMarkdown(dir)) {
    const text = readFileSync(md, "utf8");
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!existsSync(join(dirname(md), target))) {
        errors.push(`${relative(dir, md)} links a missing file: ${target}`);
      }
    }
    // A skill's files name their references in backticks. Resolve every such
    // mention against the owning skill's references/ directory.
    const [top, skill] = relative(dir, md).split(sep);
    if (top === "skills" && skill && !skill.endsWith(".md")) {
      const refDir = join(dir, "skills", skill, "references");
      for (const m of text.matchAll(/`(tools-[a-z0-9-]+\.md)`/g)) {
        if (!existsSync(join(refDir, m[1]))) {
          errors.push(`${relative(dir, md)} names a missing reference: references/${m[1]}`);
        }
      }
    }
  }
}

/**
 * Verify one power directory.
 * @param {string} dir
 * @returns {{ errors: string[], name: string | undefined, skills: string[] }}
 */
export function verifyPower(dir) {
  const errors = [];
  const manifest = verifyManifest(dir, errors);
  verifyMcpConfig(dir, manifest, errors);
  const skills = verifySkills(dir, errors);
  verifyKiroExtensions(dir, errors);
  verifyLinks(dir, errors);
  return { errors, name: manifest?.name, skills };
}

function main() {
  const args = process.argv.slice(2);
  let dirs = args;
  if (dirs.length === 0) {
    const root = resolve("powers");
    if (!existsSync(root)) {
      console.log("kiro-power-verify: no powers/ directory, nothing to verify");
      return;
    }
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  }
  let failed = 0;
  for (const dir of dirs) {
    const { errors, name, skills } = verifyPower(resolve(dir));
    if (errors.length) {
      failed++;
      console.error(`kiro-power-verify: ${basename(dir)}: ${errors.length} problem(s)`);
      for (const e of errors) console.error(`  ${e}`);
    } else {
      console.log(`kiro-power-verify: ${basename(dir)} OK (name=${name}, skills=${skills.join(",") || "none"})`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
