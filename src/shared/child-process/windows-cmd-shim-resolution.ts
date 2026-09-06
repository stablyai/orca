/**
 * Resolve an npm/pnpm-generated `.cmd` shim to the program it would have run.
 *
 * Why: a `.cmd` target forces the spawn through `cmd.exe /c` with every
 * argument caret-escaped (see windows-command-line.ts for that encoding). A
 * long `cmd.exe /c` line whose caret-escaped payload is natural-language agent
 * prompt text is what Microsoft Defender for Endpoint's command-line model
 * scores as obfuscation, and `codex.cmd` sits in the spawn cluster of a real
 * MDE incident against Orca. These shims are generated files whose entire body
 * is "find node, run this script", so reading one and spawning
 * `node.exe <script> <args…>` removes cmd.exe — and with it the escaping —
 * from the process tree.
 *
 * It also removes a real limitation: cmd's parser ends the command at a raw
 * CR/LF whatever the quote state, so a multi-line agent prompt through a `.cmd`
 * shim has to be rejected outright. The resolved path has no such problem.
 *
 * Everything here is deliberately all-or-nothing. A file that does not match a
 * known shape exactly, or whose resolved target cannot be confirmed on disk,
 * returns null and the caller keeps today's `cmd.exe /c` behaviour. A
 * mis-resolution silently runs the wrong program or drops arguments, which is
 * far worse than an EDR alert.
 */
import { readFileSync, statSync, type Stats } from 'node:fs'
import { win32 } from 'node:path'

/** Escape hatch if resolution ever picks the wrong target in the field. */
const DISABLE_FLAG = 'ORCA_DISABLE_CMD_SHIM_RESOLUTION'

/** Real shims are under 2KB; anything larger is not one of these generators. */
const MAX_SHIM_BYTES = 64 * 1024

/** Both spellings of the shim's own directory. Each already ends in `\`, so the
 * separator the shim writes after it is optional and inert. */
const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`
const DP0_NODE_EXE = `"${DP0}node\\.exe"`
const dp0Path = (group: string): string => `"${DP0}(?<${group}>[^"\\r\\n]+)"`

const ECHO_OFF = String.raw`@echo off\n`
/** npm's `cmd-shim` captures its own directory through a subroutine. */
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`
/** pnpm prepends its virtual-store directories so the script can resolve deps. */
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`

/**
 * Current `cmd-shim`: picks the interpreter into `%_prog%`, then runs it from a
 * single trailing line. This is the shape of `codex.cmd`.
 */
const NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path('script')} +%\*$`,
  'i'
)

/**
 * Legacy `cmd-shim` and pnpm's `@zkochan/cmd-shim`: the same script spelled once
 * per interpreter branch.
 */
const BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path('script')} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path('scriptElse')} +%\*\n\)$`,
  'i'
)

/** `cmd-shim` for a target that needs no interpreter (a bundled `.exe`). */
const NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path('target')} +%\*$`,
  'i'
)

/** pnpm's equivalent, which omits `@echo off` and keeps only `@SETLOCAL`. */
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path('target')} +%\*$`, 'i')

// `:` matters as much as the operators: `win32.isAbsolute('D:evil.js')` is
// false, but `win32.resolve` reads the drive letter and lands on `D:\evil.js`,
// outside the shim directory entirely.
//
// Rejecting every `:` is provably free rather than merely untested: Windows
// reserves the character in a path segment, so a relative path cannot contain
// one at all. The only spellings that can are drive-qualified (`D:x`), an
// alternate data stream (`a.js:zone`), or a `\\?\` device path — and the last
// is already refused as absolute. No generator can emit a shim-relative path
// this rule would wrongly refuse.
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/

/** A target with no interpreter must be something CreateProcess can start on
 * its own. Extensionless or `.cmd` targets need cmd's own PATHEXT search, which
 * is exactly the hop being removed. */
const DIRECT_TARGET_EXTENSIONS = ['.exe', '.com']

export type ParsedWindowsCmdShim =
  | { kind: 'node'; script: string; nodePathPrefix?: string }
  | { kind: 'direct'; target: string }

/**
 * A captured path must be relative to the shim's own directory and free of the
 * characters that mean we misread the file — `%` is an unexpanded variable, the
 * rest are cmd operators we are not emulating.
 */
function isPlainRelativePath(spelled: string): boolean {
  return !UNSAFE_SHIM_PATH.test(spelled) && !win32.isAbsolute(spelled)
}

/** Collapse a shim to comparable text: shims differ only in line endings,
 * indentation and blank lines between generators and versions. */
function canonicalize(contents: string): string {
  return contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Recognise a generated shim. Pure, so the shapes are testable off Windows.
 *
 * Returns paths exactly as the shim spells them, relative to its own directory.
 */
export function parseWindowsCmdShim(contents: string): ParsedWindowsCmdShim | null {
  const canonical = canonicalize(contents)

  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: 'node', script: prog.script } : null
  }

  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups
  if (branched?.script) {
    // Both branches must name the same script; if they differ we matched a file
    // that only looks like a shim.
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null
    }
    const nodePath = branched.nodePath
    if (nodePath === undefined) {
      return { kind: 'node', script: branched.script }
    }
    // The else branch must be exactly "prefix, then whatever was there", or the
    // prepend we would reproduce is not the one the shim performs.
    if (nodePath.includes('%') || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null
    }
    return { kind: 'node', script: branched.script, nodePathPrefix: nodePath }
  }

  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target
    if (target) {
      return isPlainRelativePath(target) ? { kind: 'direct', target } : null
    }
  }
  return null
}

type ParseCacheEntry = {
  mtimeMs: number
  size: number
  parsed: ParsedWindowsCmdShim | null
}

/** Shim bodies do not change between spawns, but an upgrade rewrites them —
 * hence the mtime/size half of the key. */
const parseCache = new Map<string, ParseCacheEntry>()
const PARSE_CACHE_LIMIT = 256

/**
 * The interpreter each shim directory resolves to, keyed by that directory and
 * the PATH that was searched.
 *
 * Why cached at all: the parse cache spares the shim read but not this walk, so
 * a 30-entry PATH cost 30 `stat`s on every spawn of an already-parsed shim —
 * synchronous I/O on `resolveSpawn`, where one dead network mount in PATH
 * blocks the calling thread each time.
 *
 * Held for the process's life, including the `null` misses. A `node.exe`
 * installed after the first probe is therefore not picked up until restart: the
 * stale miss just keeps the working cmd.exe fallback, and re-probing to catch
 * an install mid-session is what this cache exists to avoid.
 */
const nodeCache = new Map<string, string | null>()
const NODE_CACHE_LIMIT = 256

function statFile(path: string): Stats | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function readParsedShim(program: string): ParsedWindowsCmdShim | null {
  // This `stat` puts synchronous I/O on the spawn path, where `resolveSpawn`
  // previously had none: a shim on an unresponsive network share now blocks the
  // caller's thread until the filesystem gives up. Judged acceptable because a
  // `.cmd` on such a share was already about to be spawned from it. It is the
  // only such cost paid when nothing resolves — the interpreter lookup runs
  // only for a shim that already parsed, and is itself cached.
  const stats = statFile(program)
  if (!stats || stats.size > MAX_SHIM_BYTES) {
    return null
  }
  const cached = parseCache.get(program)
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed
  }
  let contents: string
  try {
    contents = readFileSync(program, 'utf8')
  } catch {
    return null
  }
  const parsed = parseWindowsCmdShim(contents)
  // Clearing wholesale drops hot entries with cold ones, where an LRU would
  // not. Left as is because the cap is per-process and one entry per distinct
  // `.cmd` path Orca ever spawns; reaching it means a re-read, not a wrong
  // answer.
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear()
  }
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed })
  return parsed
}

/** Win32 resolves environment names case-insensitively; a JS object does not. */
function firstEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== undefined)
}

/**
 * The interpreter the shim itself would pick: a `node.exe` beside it, else
 * `node` from PATH.
 *
 * Not searched: the working directory, which cmd would consult first for a bare
 * name. Preferring a `node.exe` that happens to sit in the cwd over the
 * installed one is a Windows footgun, not a behaviour worth reproducing.
 *
 * Only `node.exe`, though cmd would also accept the `node.com`/`.bat`/`.cmd`
 * PATHEXT spellings. Those return null here, which is a clean fallback to the
 * cmd path — a `.cmd` node in particular is a hop we could not remove anyway.
 */
function resolveShimNode(directory: string, env: NodeJS.ProcessEnv): string | null {
  const path = firstEnvKey(env, 'PATH')
  const pathValue = (path ? env[path] : undefined) ?? ''
  // Both inputs are in the key because both decide the answer: the shim prefers
  // its own directory, and falls back to PATH. A PATH edit between spawns
  // therefore misses rather than serving the previous interpreter. A newline
  // separates them because Windows allows one in neither a path nor a PATH.
  const key = `${directory}\n${pathValue}`
  const cached = nodeCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const resolved = probeShimNode(directory, pathValue)
  // Same wholesale eviction as the parse cache, for the same reason: the cap is
  // per-process and one entry per distinct shim directory Orca ever spawns from.
  if (nodeCache.size >= NODE_CACHE_LIMIT) {
    nodeCache.clear()
  }
  nodeCache.set(key, resolved)
  return resolved
}

function probeShimNode(directory: string, pathValue: string): string | null {
  const sibling = win32.join(directory, 'node.exe')
  if (statFile(sibling)) {
    return sibling
  }
  for (const entry of pathValue.split(';')) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, '$1')
    // A relative PATH entry resolves against the child's working directory, so
    // we cannot answer it here.
    if (!trimmed || !win32.isAbsolute(trimmed)) {
      continue
    }
    const candidate = win32.join(trimmed, 'node.exe')
    if (statFile(candidate)) {
      return candidate
    }
  }
  return null
}

function withNodePath(env: NodeJS.ProcessEnv, prefix: string): NodeJS.ProcessEnv {
  const key = firstEnvKey(env, 'NODE_PATH') ?? 'NODE_PATH'
  const existing = env[key]
  // `IF NOT DEFINED` is false for an empty value too — cmd has no empty variables.
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix }
}

export type WindowsCmdShimResolution = {
  /** Executable to spawn in place of the `.cmd`. */
  program: string
  /** Arguments the shim inserts ahead of the caller's own argv. */
  prefixArgs: readonly string[]
  /** Set only when the shim itself mutates the environment (pnpm's NODE_PATH). */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve `program` to the executable its shim body would have launched, or
 * null to keep the `cmd.exe /c` path.
 *
 * `env` is the environment the child will actually receive, because both the
 * PATH lookup for `node` and the NODE_PATH prepend depend on it.
 */
export function resolveWindowsCmdShim(
  program: string,
  env: NodeJS.ProcessEnv
): WindowsCmdShimResolution | null {
  const disableKey = firstEnvKey(env, DISABLE_FLAG)
  if (disableKey && env[disableKey]) {
    return null
  }
  // A relative program is resolved against the child's working directory, which
  // is the caller's to decide, not ours to guess.
  if (!win32.isAbsolute(program)) {
    return null
  }
  const parsed = readParsedShim(program)
  if (!parsed) {
    return null
  }
  const directory = win32.dirname(program)

  // `resolve` collapses the `..` hops and the doubled separator `%dp0%\` leaves.
  if (parsed.kind === 'direct') {
    const target = win32.resolve(directory, parsed.target)
    const lower = target.toLowerCase()
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null
  }

  const script = win32.resolve(directory, parsed.script)
  if (!statFile(script)) {
    return null
  }
  const node = resolveShimNode(directory, env)
  if (!node) {
    return null
  }
  return {
    program: node,
    prefixArgs: [script],
    ...(parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {})
  }
}
