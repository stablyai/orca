import type { AppState } from '@/store/types'
import type { TerminalPaneLayoutNode } from '../../../../shared/workspace-layout/terminal-tab-types'

/** A remote host adopts a tab the window created under `web-terminal-<id>`; both name one tab. */
const MIRRORED_TAB_PREFIX = 'web-terminal-'

function baseRunTabId(tabId: string): string {
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

function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined, out: string[]): string[] {
  if (!node) {
    return out
  }
  if (node.type === 'leaf') {
    out.push(node.leafId)
  } else {
    collectLeafIds(node.first, out)
    collectLeafIds(node.second, out)
  }
  return out
}

/** Every pane of the run's tab, in layout order. */
export function runTabLeafIds(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string,
  tabId: string
): string[] {
  const liveTabId = findLiveRunTabId(state, worktreeId, tabId)
  return liveTabId ? collectLeafIds(state.terminalLayoutsByTabId?.[liveTabId]?.root, []) : []
}

/** The PTY of the run's own pane, falling back to the tab's first PTY. */
export function runPanePtyId(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'>,
  worktreeId: string,
  tabId: string,
  leafId: string | undefined
): string | undefined {
  const liveTabId = findLiveRunTabId(state, worktreeId, tabId)
  if (!liveTabId) {
    return undefined
  }
  const byLeaf = leafId
    ? state.terminalLayoutsByTabId?.[liveTabId]?.ptyIdsByLeafId?.[leafId]
    : undefined
  return byLeaf ?? state.ptyIdsByTabId[liveTabId]?.[0]
}
