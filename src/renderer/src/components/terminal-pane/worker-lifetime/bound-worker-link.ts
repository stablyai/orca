import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { stripLeadingAgentTitleDecoration } from '../../../../../shared/agent-status/title/agent-title-decoration'
import type { BoundWorker } from '../../../../../shared/orchestration/workers/worker-auto-close'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

type WorkerTab = TerminalTab

export type BoundWorkerLink = {
  name: string
  /** The worker's tab while it is open, for its agent icon. */
  tab?: WorkerTab
  /** The worker's own pane to focus; null once its terminal is gone, so the name is plain text. */
  reveal: { worktreeId: string; paneKey: string } | null
}

/** The worker a bound terminal closes with, named as its tab shows it. */
export function boundWorkerLink(
  boundTo: BoundWorker,
  tabsByWorktree: Record<string, readonly WorkerTab[] | undefined>,
  fallbackName: string
): BoundWorkerLink {
  const tabId = parsePaneKey(boundTo.paneKey)?.tabId
  const tab = tabId ? findTab(tabsByWorktree, tabId, boundTo.worktreeId) : undefined
  if (!tab) {
    return { name: boundTo.name ?? fallbackName, reveal: null }
  }
  return {
    name: tab.customTitle ?? stripLeadingAgentTitleDecoration(tab.title),
    tab,
    reveal: { worktreeId: tab.worktreeId, paneKey: boundTo.paneKey }
  }
}

function findTab(
  tabsByWorktree: Record<string, readonly WorkerTab[] | undefined>,
  tabId: string,
  worktreeId: string | null
): WorkerTab | undefined {
  const own = worktreeId ? tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId) : undefined
  return (
    own ??
    Object.values(tabsByWorktree)
      .flatMap((tabs) => tabs ?? [])
      .find((tab) => tab.id === tabId)
  )
}
