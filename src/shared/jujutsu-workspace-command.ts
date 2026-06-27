// Command construction and output parsing for Jujutsu (`jj`) workspaces — the
// jj equivalent of git worktrees, used to spawn parallel agent sessions in a
// jj repo (see issue stablyai/orca#1082). Kept pure and binary-free so it can
// be unit tested without `jj` installed; the runtime wrapper in
// src/main/jujutsu/workspace.ts executes these args via commandExecFileAsync.

export const JUJUTSU_BIN = 'jj'

export type JujutsuWorkspaceInfo = {
  name: string
  // Absolute workspace root. Empty only when listing fell back to the
  // template-less format on jj < 0.32, which cannot print paths.
  path: string
}

// Tab-separated `name<TAB>absolute-root` per workspace. `root()` is a
// WorkspaceRef template method (jj >= 0.32); older clients reject `--template`
// entirely, so the runtime wrapper falls back to buildJjWorkspaceListDefaultArgs.
export const JJ_WORKSPACE_LIST_TEMPLATE = 'name ++ "\\t" ++ root() ++ "\\n"'

/** Args for the path-bearing workspace listing (requires jj >= 0.32). */
export function buildJjWorkspaceListArgs(): string[] {
  return ['workspace', 'list', '--template', JJ_WORKSPACE_LIST_TEMPLATE]
}

/** Args for the template-less workspace listing used as the older-jj fallback. */
export function buildJjWorkspaceListDefaultArgs(): string[] {
  return ['workspace', 'list']
}

/** Parse `name<TAB>path` output from {@link buildJjWorkspaceListArgs}. */
export function parseJujutsuWorkspaceList(stdout: string): JujutsuWorkspaceInfo[] {
  const result: JujutsuWorkspaceInfo[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) {
      continue
    }
    const tab = line.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const name = line.slice(0, tab).trim()
    const path = line.slice(tab + 1).trim()
    if (name && path) {
      result.push({ name, path })
    }
  }
  return result
}

// Default `jj workspace list` prints `name: <commit summary>` per line and has
// no path. Parse names only so older clients still get a usable listing; paths
// come back empty and callers fall back to `jj workspace root` when needed.
export function parseJujutsuWorkspaceListDefault(stdout: string): JujutsuWorkspaceInfo[] {
  const result: JujutsuWorkspaceInfo[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) {
      continue
    }
    const colon = line.indexOf(':')
    const name = (colon === -1 ? line : line.slice(0, colon)).trim()
    if (name) {
      result.push({ name, path: '' })
    }
  }
  return result
}

export type JujutsuWorkspaceAddInput = {
  // Absolute, empty-or-missing leaf path. jj refuses to populate a non-empty
  // directory and only creates a single trailing component, matching the
  // contract Orca already uses for git worktree paths.
  worktreePath: string
  name?: string
  baseRevision?: string
}

/** Build `jj workspace add [--name N] [--revision R] <path>`. */
export function buildJjWorkspaceAddArgs(input: JujutsuWorkspaceAddInput): string[] {
  const args = ['workspace', 'add']
  const name = input.name?.trim()
  if (name) {
    args.push('--name', name)
  }
  const base = input.baseRevision?.trim()
  if (base) {
    args.push('--revision', base)
  }
  args.push(input.worktreePath)
  return args
}

/** Build `jj workspace forget <name>`. */
export function buildJjWorkspaceForgetArgs(name: string): string[] {
  return ['workspace', 'forget', name]
}

/** Build `jj workspace root`. */
export function buildJjWorkspaceRootArgs(): string[] {
  return ['workspace', 'root']
}

/** Build `jj git remote list`, whose output feeds {@link parseJujutsuRemoteNames}. */
export function buildJjRemoteListArgs(): string[] {
  return ['git', 'remote', 'list']
}

// `jj git remote list` prints `<name> <url>` per line; take the first token so
// callers can tell a real remote (`origin`) from a slash in a local bookmark.
export function parseJujutsuRemoteNames(stdout: string): string[] {
  const names: string[] = []
  for (const rawLine of stdout.split('\n')) {
    const name = rawLine.trim().split(/\s+/)[0]
    if (name) {
      names.push(name)
    }
  }
  return names
}

/**
 * Mirror the name jj infers from the leaf directory so Orca's chosen name lines
 * up with `jj workspace list`. Separator-agnostic to stay correct on Windows.
 */
export function jujutsuWorkspaceNameForPath(worktreePath: string): string {
  const trimmed = worktreePath.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments.at(-1) ?? ''
}

/**
 * Translate a git base ref into a jj revset. Orca's base picker yields
 * remote-tracking names like `origin/main` or local names like `main` or even
 * `feature/foo`. jj addresses a remote bookmark as `main@origin`, but local
 * bookmarks may legitimately contain slashes — so a `<prefix>/<rest>` ref is
 * rewritten to `<rest>@<prefix>` ONLY when `<prefix>` is a known jj remote.
 * Everything else (including slash-containing local bookmarks) is passed
 * through verbatim for jj to resolve, avoiding a wrong-revision rewrite.
 */
export function resolveJujutsuBaseRevision(
  baseRef: string | undefined,
  knownRemotes: readonly string[] = []
): string | undefined {
  if (!baseRef) {
    return undefined
  }
  const trimmed = baseRef.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.includes('@')) {
    return trimmed
  }
  const slash = trimmed.indexOf('/')
  if (slash > 0 && !trimmed.includes('/', slash + 1)) {
    const remote = trimmed.slice(0, slash)
    const bookmark = trimmed.slice(slash + 1)
    if (remote && bookmark && knownRemotes.includes(remote)) {
      return `${bookmark}@${remote}`
    }
  }
  return trimmed
}
