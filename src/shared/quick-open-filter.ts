/**
 * Shared, pure Quick Open (Cmd/Ctrl+P) file-listing filter policy used by both the local main
 * process and the SSH relay. No IO, Electron, WSL, or auth — callers own process execution and
 * transport-specific path translation.
 *
 * Centralized to stop local/relay listFiles from drifting on blocklist, ignores, exclusions,
 * timeouts, and buffering. See docs/design/share-quick-open-file-listing.md.
 */
import { posix, win32 } from 'node:path'

// ─── Hidden-dir blocklist ────────────────────────────────────────────

// Blocklist (not allowlist) keeps novel dotfiles discoverable; entries here are tool-generated
// caches/state, never hand-edited. Do NOT add user-authored dotdirs (.config, .ssh, .github) — users open files there.
export const HIDDEN_DIR_BLOCKLIST: ReadonlySet<string> = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.stably',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky',
  // Home-dir cache/install/runtime state; caused the original $HOME-root 10s-timeout bug.
  '.npm',
  '.npm-global',
  '.gvfs'
])

// `.local` may hold user files; block only the generated `.local/share` runtime subtree.
const HIDDEN_PATH_BLOCKLIST: readonly string[] = ['.local/share']

// Separate from HIDDEN_DIR_BLOCKLIST: node_modules isn't a dotdir but must still be pruned.
const NON_DOTTED_PRUNE = 'node_modules'

function containsBlockedRelPath(path: string, blockedPath: string): boolean {
  return (
    path === blockedPath ||
    path.startsWith(`${blockedPath}/`) ||
    path.endsWith(`/${blockedPath}`) ||
    path.includes(`/${blockedPath}/`)
  )
}

/**
 * Returns true if `path` (`/`-separated, root-relative) traverses no blocklisted segment.
 * Correctness backstop after the rg/git pruning globs, in case a blocked dir slips through.
 * Walks segment-by-segment (no split allocation) since it runs once per file on ~100k-file repos.
 */
export function shouldIncludeQuickOpenPath(path: string): boolean {
  for (const blockedPath of HIDDEN_PATH_BLOCKLIST) {
    if (containsBlockedRelPath(path, blockedPath)) {
      return false
    }
  }
  let start = 0
  const len = path.length
  while (start < len) {
    let end = path.indexOf('/', start)
    if (end === -1) {
      end = len
    }
    const segment = path.substring(start, end)
    if (segment === NON_DOTTED_PRUNE || HIDDEN_DIR_BLOCKLIST.has(segment)) {
      return false
    }
    start = end + 1
  }
  return true
}

// ─── Path flavor detection ───────────────────────────────────────────

// Why: local-OS path.relative is wrong for remote roots (app OS vs relay OS); pick win32 vs posix by root shape.
function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  // Drive letter like C:\ or C:/
  if (/^[a-zA-Z]:[\\/]/.test(rootPath)) {
    return win32
  }
  // UNC \\server\share or //server/share
  if (rootPath.startsWith('\\\\') || rootPath.startsWith('//')) {
    return win32
  }
  return posix
}

// ─── Exclude-path normalization ──────────────────────────────────────

/**
 * Normalize `excludePaths` (renderer-sent absolute paths for nested worktrees) into `/`-separated,
 * root-relative prefixes. Malformed/outside-root/root-equal values are silently dropped so a stale
 * or typo'd exclude path can't fail the request.
 */
export function buildExcludePathPrefixes(rootPath: string, excludePaths?: unknown): string[] {
  if (!Array.isArray(excludePaths)) {
    return []
  }
  const flavor = pathFlavor(rootPath)
  // Trim trailing separators so comparison is stable.
  const trimmedRoot = rootPath.replace(/[\\/]+$/, '')
  const normalizedRoot = `${trimmedRoot.replace(/\\/g, '/')}/`
  const out: string[] = []
  for (const raw of excludePaths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      continue
    }
    // Fast path: input already under the root with the same separator shape.
    const rawFwd = raw.replace(/\\/g, '/')
    let rel: string
    if (rawFwd === normalizedRoot.slice(0, -1)) {
      // Root-equal — refuse to exclude the whole tree.
      continue
    }
    rel = rawFwd.startsWith(normalizedRoot)
      ? rawFwd.slice(normalizedRoot.length)
      : // Fall back to path-flavor relative so remote paths don't get local-OS semantics.
        flavor.relative(trimmedRoot, raw).replace(/\\/g, '/')
    if (!rel || isParentRelativePath(rel) || rel.startsWith('/')) {
      continue
    }
    // Strip any trailing slash so boundary checks are unambiguous.
    rel = rel.replace(/\/+$/, '')
    if (rel.length === 0) {
      continue
    }
    out.push(rel)
  }
  return out
}

/**
 * Segment-boundary exclude check (`relPath` is `/`-separated, root-relative).
 * Why segment boundary: a raw `startsWith` would match `packages/app2` against exclusion `packages/app`.
 */
export function shouldExcludeQuickOpenRelPath(
  relPath: string,
  excludePathPrefixes: readonly string[]
): boolean {
  for (const prefix of excludePathPrefixes) {
    if (relPath === prefix) {
      return true
    }
    if (relPath.length > prefix.length && relPath.startsWith(`${prefix}/`)) {
      return true
    }
  }
  return false
}

// ─── Glob escaping ───────────────────────────────────────────────────

// rg/git glob metacharacters; escape embedded dir names so a dir named `feature[1]` doesn't exclude `feature1`.
const GLOB_META = new Set<string>(['*', '?', '[', ']', '{', '}', '\\'])

function escapeGlob(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    out += GLOB_META.has(ch) ? `\\${ch}` : ch
  }
  return out
}

function escapeGlobPath(relPath: string): string {
  // Split on '/' so the separators are not themselves escaped.
  return relPath.split('/').map(escapeGlob).join('/')
}

function isParentRelativePath(relPath: string): boolean {
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return relPath === '..' || relPath.startsWith('../')
}

// ─── rg traversal-pruning globs ──────────────────────────────────────

/**
 * Build the hidden-dir traversal-pruning glob args for rg (includes `node_modules`).
 * Uses directory-match form `!**\/name` not contents form `!**\/name/**`: rg still descends into a
 * dir matched only by the contents form, so only the directory form actually prunes traversal.
 */
export function buildHiddenDirExcludeGlobs(): string[] {
  const names = [NON_DOTTED_PRUNE, ...HIDDEN_DIR_BLOCKLIST]
  const out: string[] = []
  for (const name of names) {
    out.push('--glob', `!**/${escapeGlob(name)}`)
  }
  for (const blockedPath of HIDDEN_PATH_BLOCKLIST) {
    out.push('--glob', `!**/${escapeGlobPath(blockedPath)}`)
  }
  return out
}

// ─── rg arg builder ──────────────────────────────────────────────────

export type RgArgsOptions = {
  /** rg positional search target: absolute root (strip prefix from output) or `.` (cwd-relative); both need cwd: rootPath. */
  searchRoot: string
  /** Root-relative, `/`-separated prefixes (from buildExcludePathPrefixes). */
  excludePathPrefixes: readonly string[]
  /** On Windows rg emits `\\`-separated paths; pass true to force `/` output. */
  forceSlashSeparator: boolean
}

export type RgArgs = {
  /** Main pass: all non-ignored files, hidden dotfiles included. */
  primary: string[]
  /** Second pass: ignored files, hidden dotfiles included. */
  ignoredPass: string[]
}

/**
 * Build the two rg arg arrays for Quick Open. Caller must spawn with `cwd: rootPath` — root-relative
 * globs are evaluated against rg's cwd, so omitting it silently breaks nested-worktree exclusions.
 * Deliberately omits `--follow` so symlinks can't escape the authorized root or cause traversal loops.
 */
export function buildRgArgsForQuickOpen(opts: RgArgsOptions): RgArgs {
  const sepArgs = opts.forceSlashSeparator ? ['--path-separator', '/'] : []
  const hiddenDirGlobs = buildHiddenDirExcludeGlobs()
  const excludeGlobs: string[] = []
  for (const prefix of opts.excludePathPrefixes) {
    // Directory-match form so rg prunes the nested worktree's traversal, not just its listed files.
    excludeGlobs.push('--glob', `!${escapeGlobPath(prefix)}`)
    excludeGlobs.push('--glob', `!${escapeGlobPath(prefix)}/**`)
  }

  const primary = [
    '--files',
    '--hidden',
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  // Ignored pass: --no-ignore-vcs broadens to gitignored/parent/global ignored files; blocklist globs still guard.
  const ignoredPass = [
    '--files',
    '--hidden',
    '--no-ignore-vcs',
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  return { primary, ignoredPass }
}

// ─── rg stdout line normalization ────────────────────────────────────

export type RgOutputMode =
  /** rg was invoked with an absolute search target; output paths are absolute. */
  | { kind: 'absolute'; rootPath: string }
  /** rg invoked with cwd: rootPath and searchRoot '.'; output is cwd-relative, usually `./`-prefixed. */
  | { kind: 'cwd-relative' }

/**
 * Convert one rg --files stdout line into a root-relative, `/`-separated path.
 * Returns `null` for lines that escape the root (symlink edge cases) or can't be normalized.
 * Callers do any WSL translation first, keeping WSL out of the shared module.
 */
export function normalizeQuickOpenRgLine(rawLine: string, outputMode: RgOutputMode): string | null {
  let line = rawLine
  // Strip CR so CRLF from rg on Windows doesn't leak into results.
  if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
    line = line.substring(0, line.length - 1)
  }
  if (!line) {
    return null
  }
  const normalized = line.replace(/\\/g, '/')
  if (outputMode.kind === 'cwd-relative') {
    let rel = normalized
    if (rel.startsWith('./')) {
      rel = rel.slice(2)
    } else if (rel === '.') {
      return null
    }
    if (!rel || rel.startsWith('/') || isParentRelativePath(rel)) {
      return null
    }
    return rel
  }
  // Absolute mode: strip the root prefix.
  // Why: only replace backslashes; collapsing repeated slashes would break Windows UNC roots (`\\server\share`).
  const normalizedRoot = `${outputMode.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  if (normalized.startsWith(normalizedRoot)) {
    const rel = normalized.substring(normalizedRoot.length)
    if (!rel || isParentRelativePath(rel) || rel.startsWith('/')) {
      return null
    }
    return rel
  }
  return null
}

// ─── git ls-files arg builder ────────────────────────────────────────

export type GitLsFilesArgs = {
  primary: string[]
  ignoredPass: string[]
}

/**
 * Build the two `git ls-files` arg arrays for Quick Open. A positive `.` pathspec is prepended
 * so the exclude-only `:(exclude,glob)` pathspecs don't depend on git's edge-case defaults.
 */
export function buildGitLsFilesArgsForQuickOpen(
  excludePathPrefixes: readonly string[] = []
): GitLsFilesArgs {
  const excludeSpecs: string[] = []
  for (const prefix of excludePathPrefixes) {
    excludeSpecs.push(`:(exclude,glob)${escapeGlobPath(prefix)}`)
    excludeSpecs.push(`:(exclude,glob)${escapeGlobPath(prefix)}/**`)
  }
  const trailingPathspecs = excludeSpecs.length > 0 ? ['--', '.', ...excludeSpecs] : []
  // Why: collapse untracked trees so callers expand only allowed dir placeholders via the bounded walker.
  const directoryCollapseArgs = ['--directory', '--no-empty-directory']

  // Why: -z NUL preserves real Git paths; -s stage mode identifies gitlinks without lstat probes.
  const primary = [
    '-z',
    '-s',
    '--cached',
    '--others',
    '--exclude-standard',
    ...directoryCollapseArgs,
    ...trailingPathspecs
  ]
  const ignoredPass = [
    '-z',
    '-s',
    '--others',
    '--ignored',
    '--exclude-standard',
    ...directoryCollapseArgs,
    ...trailingPathspecs
  ]
  return { primary, ignoredPass }
}
