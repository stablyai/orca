import type { AppState } from '@/store/types'

// Why: these selectors return fresh maps whose top-level values preserve
// underlying per-tab references, so callers must compare them shallowly.

type WorktreeCardStatusInputState = Pick<
  AppState,
  'tabsByWorktree' | 'runtimePaneTitlesByTabId' | 'ptyIdsByTabId'
>

export function selectRuntimePaneTitlesForWorktree(
  state: WorktreeCardStatusInputState,
  worktreeId: string
): Record<string, Record<number, string>> {
  const out: Record<string, Record<number, string>> = {}
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
    if (paneTitles) {
      out[tab.id] = paneTitles
    }
  }
  return out
}

export function selectLivePtyIdsForWorktree(
  state: WorktreeCardStatusInputState,
  worktreeId: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const ids = state.ptyIdsByTabId[tab.id]
    if (ids && ids.length > 0) {
      out[tab.id] = ids
    }
  }
  return out
}
