import type { AppState } from '@/store/types'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

// Why: these selectors return fresh maps whose top-level values preserve
// underlying per-tab references, so callers must compare them shallowly.

type WorktreeCardStatusInputState = Pick<AppState, 'runtimePaneTitlesByTabId' | 'ptyIdsByTabId'> & {
  tabsByWorktree: Record<string, readonly { id: string }[]>
}

type WorktreeCardLayoutRootInputState = Pick<AppState, 'terminalLayoutsByTabId'> & {
  tabsByWorktree: Record<string, readonly { id: string }[]>
}

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

export function selectTerminalLayoutRootsForWorktree(
  state: WorktreeCardLayoutRootInputState,
  worktreeId: string
): Record<string, TerminalPaneLayoutNode | null | undefined> {
  const out: Record<string, TerminalPaneLayoutNode | null | undefined> = {}
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    out[tab.id] = state.terminalLayoutsByTabId[tab.id]?.root
  }
  return out
}

export function selectTerminalLayoutRootsForWorktrees(
  state: WorktreeCardLayoutRootInputState,
  worktreeIds: readonly string[]
): Record<string, TerminalPaneLayoutNode | null | undefined> {
  const out: Record<string, TerminalPaneLayoutNode | null | undefined> = {}
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      out[tab.id] = state.terminalLayoutsByTabId[tab.id]?.root
    }
  }
  return out
}
