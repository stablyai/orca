// Command construction and output parsing for Jujutsu (`jj`) workspaces — the
// jj equivalent of git worktrees, used to spawn parallel agent sessions in a
// jj repo (see issue stablyai/orca#1082). Kept pure and binary-free so it can
// be unit tested without `jj` installed; the runtime wrapper in
// src/main/jujutsu/workspace.ts executes these args via commandExecFileAsync.

export const JUJUTSU_BIN = 'jj'

export type JujutsuWorkspaceInfo = {
  name: string
  path: string
}

// Tab-separated `name<TAB>absolute-root` per workspace. `root()` is a
// WorkspaceRef template method (jj >= 0.40); older clients reject it, so the
// runtime wrapper degrades to a name-only listing on failure.
export const JJ_WORKSPACE_LIST_TEMPLATE = 'name ++ "\\t" ++ root() ++ "\\n"'

export function buildJjWorkspaceListArgs(): string[] {
  return ['workspace', 'list', '--template', JJ_WORKSPACE_LIST_TEMPLATE]
}

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

export type JujutsuWorkspaceAddInput = {
  // Absolute, empty-or-missing leaf path. jj refuses to populate a non-empty
  // directory and only creates a single trailing component, matching the
  // contract Orca already uses for git worktree paths.
  worktreePath: string
  name?: string
  baseRevision?: string
}

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

export function buildJjWorkspaceForgetArgs(name: string): string[] {
  return ['workspace', 'forget', name]
}

export function buildJjWorkspaceRootArgs(): string[] {
  return ['workspace', 'root']
}

// Mirror the name jj infers from the leaf directory so Orca's chosen name lines
// up with `jj workspace list`. Separator-agnostic to stay correct on Windows.
export function jujutsuWorkspaceNameForPath(worktreePath: string): string {
  const trimmed = worktreePath.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments.at(-1) ?? ''
}

// Best-effort translation of a git base ref into a jj revset. Orca's base
// picker yields remote-tracking names like `origin/main` or local names like
// `main`; jj addresses a remote bookmark as `main@origin`, while a bare name
// resolves as a local bookmark or revision. Anything carrying an explicit `@`
// or extra path segments is passed through for jj to resolve (or reject).
export function resolveJujutsuBaseRevision(baseRef: string | undefined): string | undefined {
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
    if (remote && bookmark) {
      return `${bookmark}@${remote}`
    }
  }
  return trimmed
}
