/** Pure listing policy shared by main/SSH relay to keep pruning, exclusions and limits aligned; callers own I/O and path translation
 * (docs/design/share-quick-open-file-listing.md). */
import { isWindowsAbsolutePathLike, relativePathInsideRoot } from './cross-platform-path'

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

/** Segment-walk without split allocation for ~100k-file repos; backstop rg/git pruning when blocked paths slip through. */
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

/** Normalize absolute excludes to root-relative slash prefixes; ignore malformed/outside/equal-root inputs so stale paths cannot fail listing. */
export function buildExcludePathPrefixes(rootPath: string, excludePaths?: unknown): string[] {
  if (!Array.isArray(excludePaths)) {
    return []
  }
  const out: string[] = []
  for (const raw of excludePaths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      continue
    }
    const relativePath = relativePathInsideRoot(rootPath, raw)
    if (relativePath === null) {
      continue
    }
    let rel = isWindowsAbsolutePathLike(rootPath) ? relativePath.replace(/\\/g, '/') : relativePath
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

/** Match segment boundaries so excluding packages/app does not hide packages/app2. */
export function shouldExcludeQuickOpenRelPath(
  relPath: string,
  excludePathPrefixes: readonly string[]
): boolean {
  for (const prefix of excludePathPrefixes) {
    if (relPath === prefix) {
      return true
    }
    if (relPath[prefix.length] === '/' && relPath.startsWith(prefix)) {
      return true
    }
  }
  return false
}

// Escape literal directory names so feature[1] cannot accidentally exclude feature1.
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

/** Directory-match globs prune traversal, unlike contents-only exclusions; include node_modules. */
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

export type RgArgsOptions = {
  /** Symlink traversal is opt-in; opening discovered paths still requires authorization. */
  followSymlinks?: boolean
  searchRoot: string
  /** Root-relative, `/`-separated prefixes (from buildExcludePathPrefixes). */
  excludePathPrefixes: readonly string[]
  /** On Windows rg emits `\\`-separated paths; pass true to force `/` output. */
  forceSlashSeparator: boolean
}

export type RgArgs = {
  /** Main pass: all non-ignored files, hidden dotfiles included. */
  primary: string[]
  /** Broader pass: primary files plus gitignored files, hidden dotfiles included. */
  ignoredPass: string[]
}

/** Run both passes with cwd:rootPath so root-relative nested-worktree exclusions work. Explicit symlink following
 * does not authorize opening the resulting paths. */
export function buildRgArgsForQuickOpen(opts: RgArgsOptions): RgArgs {
  const followArgs = opts.followSymlinks ? ['--follow'] : []
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
    '--no-config',
    '--null',
    '--hidden',
    ...followArgs,
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  // Ignored pass: --no-ignore-vcs broadens to gitignored/parent/global ignored files; blocklist globs still guard.
  const ignoredPass = [
    '--files',
    '--no-config',
    '--null',
    '--hidden',
    '--no-ignore-vcs',
    ...followArgs,
    ...sepArgs,
    ...hiddenDirGlobs,
    ...excludeGlobs,
    opts.searchRoot
  ]

  return { primary, ignoredPass }
}

export type RgOutputMode =
  /** rg was invoked with an absolute search target; output paths are absolute. */
  | { kind: 'absolute'; rootPath: string }
  /** rg invoked with cwd: rootPath and searchRoot '.'; output is cwd-relative, usually `./`-prefixed. */
  | { kind: 'cwd-relative' }

/** Normalize NUL-delimited records inside the root; callers translate WSL paths before entering this platform-neutral policy. */
export function normalizeQuickOpenRgLine(rawLine: string, outputMode: RgOutputMode): string | null {
  const line = rawLine
  if (!line) {
    return null
  }
  const windowsPath =
    outputMode.kind === 'absolute' && isWindowsAbsolutePathLike(outputMode.rootPath)
  const normalized = windowsPath ? line.replace(/\\/g, '/') : line
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
  // Only replace backslashes; collapsing repeated slashes would corrupt Windows UNC roots.
  const root = windowsPath ? outputMode.rootPath.replace(/\\/g, '/') : outputMode.rootPath
  const normalizedRoot = `${root.replace(/\/+$/, '')}/`
  if (normalized.startsWith(normalizedRoot)) {
    const rel = normalized.substring(normalizedRoot.length)
    if (!rel || isParentRelativePath(rel) || rel.startsWith('/')) {
      return null
    }
    return rel
  }
  return null
}

export type GitLsFilesArgs = {
  primary: string[]
  ignoredPass: string[]
}

/** Prepend positive . pathspec before exclude-only specs to avoid Git’s edge-case default selection. */
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
