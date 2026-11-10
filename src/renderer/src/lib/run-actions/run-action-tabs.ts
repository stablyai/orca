import type { AppState } from '@/store/types'

/** A remote host adopts a tab the window created under `web-terminal-<id>`; both name one tab. */
const MIRRORED_TAB_PREFIX = 'web-terminal-'

export function baseRunTabId(tabId: string): string {
  return tabId.startsWith(MIRRORED_TAB_PREFIX) ? tabId.slice(MIRRORED_TAB_PREFIX.length) : tabId
}

export function sameRunTab(a: string, b: string): boolean {
  return baseRunTabId(a) === baseRunTabId(b)
}

/** The id the run's tab has now, or null when the workspace no longer has it. */
export function findLiveRunTabId(
  state: Pick<AppState, 'tabsByWorktree'>,
  worktreeId: string,
  tabId: string
): string | null {
  return (
    (state.tabsByWorktree[worktreeId] ?? []).find((tab) => sameRunTab(tab.id, tabId))?.id ?? null
  )
}
