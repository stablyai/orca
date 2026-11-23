import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { stripLeadingAgentTitleDecoration } from '../../../../../shared/agent-status/title/agent-title-decoration'
import type { BoundWorker } from '../../../../../shared/orchestration/workers/worker-auto-close'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

export type BoundWorkerLink = {
  name: string
  /** The worker's tab while it is open, for its agent icon. */
  tab?: TerminalTab
  /** The worker's own pane to focus; null once its terminal is gone, so the name is plain text. */
  reveal: { worktreeId: string; paneKey: string } | null
}

/** The worker's open tab, looked up in its own workspace first; a store selector, so it returns the
 *  stored tab itself and allocates nothing. */
export function findBoundWorkerTab(
  tabsByWorktree: Record<string, readonly TerminalTab[] | undefined>,
  boundTo: BoundWorker
): TerminalTab | undefined {
  const tabId = parsePaneKey(boundTo.paneKey)?.tabId
  if (!tabId) {
    return undefined
  }
  const own = boundTo.worktreeId
    ? tabsByWorktree[boundTo.worktreeId]?.find((tab) => tab.id === tabId)
    : undefined
  if (own) {
    return own
  }
  for (const tabs of Object.values(tabsByWorktree)) {
    const tab = tabs?.find((candidate) => candidate.id === tabId)
    if (tab) {
      return tab
    }
  }
  return undefined
}

/** The worker a bound terminal closes with, named as its tab shows it. */
export function boundWorkerLink(
  boundTo: BoundWorker,
  tab: TerminalTab | undefined,
  fallbackName: string
): BoundWorkerLink {
  if (!tab) {
    return { name: boundTo.name ?? fallbackName, reveal: null }
  }
  return {
    name: tab.customTitle ?? stripLeadingAgentTitleDecoration(tab.title),
    tab,
    reveal: { worktreeId: tab.worktreeId, paneKey: boundTo.paneKey }
  }
}
