/**
 * Shared, pure Quick Open (Cmd/Ctrl+P) file-listing filter policy used by both
 * the local main process and the SSH relay. No IO, no Electron, no WSL, no
 * auth — callers own process execution and transport-specific path translation.
 *
 * Why this module exists (design doc: docs/design/share-quick-open-file-listing.md):
 * Before extraction, the local and relay listFiles implementations had diverged
 * on blocklist, .env* handling, nested-worktree exclusions, timeout strategy,
 * and buffering. A home-dir worktree over SSH would descend into $HOME dotfile
 * caches, hit a 10s timeout, and silently resolve with a partial result —
 * Quick Open showed "No matching files" even though the scan was incomplete.
 * Centralizing the policy prevents future drift.
 */
import { posix, win32 } from 'path'

// ─── Hidden-dir blocklist ────────────────────────────────────────────

// Why: with rg --hidden we surface dotfiles users commonly edit (.env,
// .github/*, .eslintrc). A blocklist (not an allowlist) keeps novel dotfiles
// discoverable by default; the entries here are tool-generated caches / state
// that are never hand-edited. Do NOT add broad user-authored dotdirs like
// .config, .ssh, .gnupg, .github, .devcontainer — users open files in them.
//
// .npm, .npm-global, .local/share, .gvfs added for the home-root failure
// (design doc): these are generated package cache, install state, desktop
// runtime state — not normal project source.
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
  // Home-dir cache/install/runtime state that caused the original bug when
  // a worktree rooted at $HOME let rg descend for 10s before timing out.
  '.npm',
  '.npm-global',
  '.gvfs'
])

// Kept separate from HIDDEN_DIR_BLOCKLIST because node_modules is not a
// dotfile dir, but it must still be pruned from every traversal.
const NON_DOTTED_PRUNE = 'node_modules'

/**
 * Returns true if `relPath` (a `/`-separated, root-relative path) does not
 * traverse through any blocklisted directory segment. Used as a correctness
 * backstop after the rg/git traversal-pruning globs — if a blocklisted dir
 * slips through (e.g., via a glob edge case), this filter still drops it.
 *
 * Why: walks the string segment-by-segment without allocating a split array,
 * since this is called once per listed file and large repos produce ~100k
 * files.
 */
export function shouldIncludeQuickOpenPath(path: string): boolean {
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

// Why: buildExcludePathPrefixes must run correctly even when the main process
// OS differs from the remote relay OS (macOS app talking to a Linux relay, or
// Windows app talking to a Linux relay). path.relative from the local OS is
// wrong for remote roots — pick win32 vs posix based on the root's shape.
function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  // Drive letter like C:\ or C:/
  if (/^[a-zA-Z]:[\\/]/.test(rootPath)) {
    return win32
  }
  // UNC \\server\share
  if (rootPath.startsWith('\\\\')) {
    return win32
  }
  return posix
}

// ─── Exclude-path normalization ──────────────────────────────────────

/**
 * Normalize `excludePaths` (absolute paths sent by the renderer for nested
 * worktrees) into `/`-separated, root-relative prefixes. Returns empty array
 * on any malformed input — the request must not fail if the renderer sends a
 * stale or typo'd exclude path.
 *
 * Design doc notes:
 * - Missing, non-array, non-string, empty, outside-root, and root-equal
 *   values are silently ignored.
 * - Always returns `/`-separated strings because rg globs and the shared
 *   Quick Open policy compare `/`-separated paths.
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
      : // Fall back to path-flavor relative so we do not accidentally use the
        // local OS's semantics on remote paths.
        flavor.relative(trimmedRoot, raw).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) {
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
 * Segment-boundary exclude check. `relPath` is `/`-separated, root-relative.
 * Returns true iff `relPath === prefix` or `relPath` starts with `prefix + '/'`.
 *
 * Why: a raw `startsWith` would match `packages/app2` against an exclusion
 * for `packages/app`. This guard is required wherever exclude prefixes are
 * used as a post-filter (git and readdir paths).
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

// rg/git glob metacharacters. Escape them when a user-supplied or directory
// name is embedded into a glob, so a directory literally named `feature[1]`
// does not silently exclude `feature1`.
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

// ─── rg traversal-pruning globs ──────────────────────────────────────

/**
 * Build the hidden-dir traversal-pruning glob args for rg (includes
 * `node_modules`). Uses the directory-match form `!**\/name` instead of the
 * contents form `!**\/name/**` because rg still descends into a directory
 * matched only by the contents form to enumerate entries — the directory
 * form is what actually prunes traversal of huge caches under $HOME.
 */
export function buildHiddenDirExcludeGlobs(): string[] {
  const names = [NON_DOTTED_PRUNE, ...HIDDEN_DIR_BLOCKLIST]
  const out: string[] = []
  for (const name of names) {
    out.push('--glob', `!**/${escapeGlob(name)}`)
  }
  return out
}

// ─── rg arg builder ──────────────────────────────────────────────────

export type RgArgsOptions = {
  /** What to pass to rg as the positional search target — pass the absolute
   *  root path when you plan to strip that prefix from output, or `.` when
   *  you prefer cwd-relative output (both require cwd: rootPath). */
  searchRoot: string
  /** Root-relative, `/`-separated prefixes (from buildExcludePathPrefixes). */
  excludePathPrefixes: readonly string[]
  /** On Windows rg emits `\\`-separated paths; pass true to force `/` output. */
  forceSlashSeparator: boolean
}

export type RgArgs = {
  /** Main pass: all non-ignored files, hidden dotfiles included. */
  primary: string[]
  /** Second pass: gitignored .env* files. */
  envPass: string[]
}

/**
 * Build the two rg arg arrays for Quick Open. The caller is responsible for
 * spawning rg with `cwd: rootPath`; root-relative globs like `!packages/app`
 * are evaluated against rg's working directory, so omitting `cwd` silently
 * breaks nested-worktree exclusions.
 *
 * The builder deliberately does not emit `--follow`: rg --files does not
 * follow symlinks by default, and enabling it on a home-dir root risks
 * escaping the authorized root (symlinks into /mnt, /tmp, other users' homes)
 * and hitting traversal loops.
 */
export function buildRgArgsForQuickOpen(opts: RgArgsOptions): RgArgs {
  const sepArgs = opts.forceSlashSeparator ? ['--path-separator', '/'] : []
  const hiddenDirGlobs = buildHiddenDirExcludeGlobs()
  const excludeGlobs: string[] = []
  for (const prefix of opts.excludePathPrefixes) {
    // Use directory-match form so rg prunes traversal of the nested worktree
    // entirely, not just drops already-listed files from it.
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

  // .env* pass: must include --no-ignore-vcs so rg surfaces gitignored .env
  // files, which is the whole reason the second pass exists. Two positive
  // globs (root-level and nested) because rg treats any positive --glob as a
  // whitelist; no preceding negative pattern is needed.
  const envPass = [
    '--files',
    '--hidden',
    '--no-ignore-vcs',
    ...sepArgs,
    '--glob',
    '.env*',
    '--glob',
    '**/.env*',
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  return { primary, envPass }
}

// ─── rg stdout line normalization ────────────────────────────────────

export type RgOutputMode =
  /** rg was invoked with an absolute search target; output paths are absolute. */
  | { kind: 'absolute'; rootPath: string }
  /** rg was invoked with cwd: rootPath and searchRoot '.'; output is cwd-relative
   *  and typically prefixed with `./`. */
  | { kind: 'cwd-relative' }

/**
 * Convert one rg --files stdout line into a root-relative, `/`-separated path.
 * Returns `null` for lines that escape the root (symlink resolution edge cases)
 * or cannot be normalized. The main-process caller is responsible for any WSL
 * translation before calling this — keeping WSL out of the shared module.
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
    if (!rel || rel.startsWith('/') || rel.startsWith('..')) {
      return null
    }
    return rel
  }
  // Absolute mode: strip the root prefix.
  // Why: replace only backslashes here. Collapsing repeated slashes breaks
  // Windows UNC roots (`\\server\share` -> `//server/share`) by turning them
  // into single-slash POSIX-looking paths that no rg output can match.
  const normalizedRoot = `${outputMode.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  if (normalized.startsWith(normalizedRoot)) {
    return normalized.substring(normalizedRoot.length)
  }
  return null
}

// ─── git ls-files arg builder ────────────────────────────────────────

export type GitLsFilesArgs = {
  primary: string[]
  envPass: string[]
}

/**
 * Build the two `git ls-files` arg arrays for Quick Open. Exclude prefixes
 * are encoded as `:(exclude,glob)` pathspecs; a positive `.` pathspec is
 * prepended so exclude-only pathspecs do not depend on git's edge-case
 * defaults.
 *
 * The `.env*` pass uses BOTH `.env*` (root-level) and `**\/.env*` (nested)
 * because the `**\/` prefix alone does not match a root-level `.env` file —
 * this was the silent bug in the prior local implementation.
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

  const primary = ['--cached', '--others', '--exclude-standard', ...trailingPathspecs]
  // Second pass: untracked AND ignored .env* files. Do not pass
  // --exclude-standard — that would re-hide gitignored .env files, which is
  // the whole reason this pass exists.
  // Why :(glob): default git pathspec uses fnmatch, where `*` crossing `/` is
  // implementation-dependent. `:(glob)` pins the semantics explicitly so
  // `**/.env*` reliably surfaces nested `.env` files across git versions.
  const nestedEnvSpec = ':(glob)**/.env*'
  const envPassPathspecs =
    excludeSpecs.length > 0
      ? ['--', '.env*', nestedEnvSpec, ...excludeSpecs]
      : ['--', '.env*', nestedEnvSpec]
  const envPass = ['--others', ...envPassPathspecs]
  return { primary, envPass }
}
