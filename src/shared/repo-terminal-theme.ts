import { parseWorkspaceKey } from './workspace-scope'
import { getRepoIdFromWorktreeId } from './worktree/id'

export type RepoTerminalThemeVariant = 'dark' | 'light'

/** Per-repo terminal theme selections (built-in name or `custom:<source>:<id>`). Missing variant = inherit global. */
export type RepoTerminalThemeOverrides = { dark?: string; light?: string }

// Custom theme ids derive from unbounded imported names, so this must comfortably exceed real ones.
export const MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH = 4096

function normalizeSelection(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH) {
    return undefined
  }
  return trimmed
}

export function normalizeRepoTerminalThemeOverrides(
  value: unknown
): RepoTerminalThemeOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const next: RepoTerminalThemeOverrides = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key !== 'dark' && key !== 'light') {
      continue
    }
    const selection = normalizeSelection(raw)
    if (selection) {
      next[key] = selection
    }
  }
  return next.dark || next.light ? next : undefined
}

/** False for a non-empty selection that normalization would drop (e.g. over the length cap). */
export function isStorableRepoTerminalThemeSelection(selection: string | null): boolean {
  return selection === null || !selection.trim() || normalizeSelection(selection) !== undefined
}

/** What a pick writes; `terminalTheme: null` is the repo-update clear sentinel (no variant left). */
export type RepoTerminalThemeUpdate =
  | { kind: 'rejected' }
  | { kind: 'update'; terminalTheme: RepoTerminalThemeOverrides | null }

export function buildRepoTerminalThemeUpdate(
  current: RepoTerminalThemeOverrides | undefined,
  variant: RepoTerminalThemeVariant,
  selection: string | null
): RepoTerminalThemeUpdate {
  // Why rejected, not a write: an unstorable pick must never read as a clear of the other variant.
  if (!isStorableRepoTerminalThemeSelection(selection)) {
    return { kind: 'rejected' }
  }
  const next: RepoTerminalThemeOverrides = { ...current }
  const trimmed = typeof selection === 'string' ? selection.trim() : ''
  if (trimmed) {
    next[variant] = trimmed
  } else {
    delete next[variant]
  }
  return { kind: 'update', terminalTheme: normalizeRepoTerminalThemeOverrides(next) ?? null }
}

/** The repo whose terminal theme a worktree's terminals use; null for folder workspaces (no Repo row). */
export function getTerminalThemeRepoId(worktreeId: string | null | undefined): string | null {
  if (!worktreeId || parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return null
  }
  return getRepoIdFromWorktreeId(worktreeId)
}
