import type { AppState } from '@/store/types'

// Which surface a Cmd-J destination workspace should hand keyboard focus to.
export type WorktreeActiveSurfaceFocusTarget =
  | { kind: 'terminal'; tabId: string; leafId: string | null }
  | { kind: 'editor' }
  | { kind: 'fallback' }

type WorktreeActiveSurfaceFocusState = Pick<
  AppState,
  'activeTabIdByWorktree' | 'activeTabTypeByWorktree' | 'terminalLayoutsByTabId'
>

// Why: decide the focus target purely from store state so the routing (active
// terminal tab + leaf / editor / generic fallback) stays unit-testable, apart
// from the DOM-focusing side effects it drives in WorktreeJumpPalette. Anything
// that is not a known terminal/editor tab (browser, simulator, or missing state)
// falls through to the generic fallback the caller handles.
export function resolveWorktreeActiveSurfaceFocus(
  state: WorktreeActiveSurfaceFocusState,
  worktreeId: string
): WorktreeActiveSurfaceFocusTarget {
  const tabId = state.activeTabIdByWorktree[worktreeId] ?? null
  const tabType = state.activeTabTypeByWorktree[worktreeId]
  if (tabId && tabType === 'terminal') {
    const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null
    return { kind: 'terminal', tabId, leafId }
  }
  if (tabType === 'editor') {
    return { kind: 'editor' }
  }
  return { kind: 'fallback' }
}
