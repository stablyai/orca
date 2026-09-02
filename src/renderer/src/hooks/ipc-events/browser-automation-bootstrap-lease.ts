import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '@/components/browser-pane/host-guest/browser-automation-visibility'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

const BROWSER_AUTOMATION_BOOTSTRAP_LEASE_MS = 10_000
const browserAutomationBootstrapLeaseByPageId = new Map<string, { token: string; timer: number }>()

function releaseBrowserAutomationBootstrapLease(browserPageId: string): void {
  const existing = browserAutomationBootstrapLeaseByPageId.get(browserPageId)
  if (!existing) {
    return
  }
  window.clearTimeout(existing.timer)
  releaseBrowserAutomationVisibility(existing.token)
  browserAutomationBootstrapLeaseByPageId.delete(browserPageId)
}

function findBrowserPageWorktreeId(store: AppState, browserPageId: string): string | null {
  for (const [worktreeId, browserTabs] of Object.entries(store.browserTabsByWorktree)) {
    for (const workspace of browserTabs) {
      if (
        workspace.id === browserPageId ||
        workspace.activePageId === browserPageId ||
        workspace.pageIds?.includes(browserPageId)
      ) {
        return worktreeId
      }
    }
  }
  for (const pages of Object.values(store.browserPagesByWorkspace)) {
    const page = pages.find((candidate) => candidate.id === browserPageId)
    if (page) {
      return page.worktreeId
    }
  }
  return null
}

export function acquireBrowserAutomationBootstrapLease(
  worktreeId: string | null | undefined,
  browserPageId?: string | null
): void {
  const store = useAppStore.getState()
  const targetWorktreeId =
    worktreeId ??
    (browserPageId ? findBrowserPageWorktreeId(store, browserPageId) : null) ??
    store.activeWorktreeId
  if (!targetWorktreeId) {
    return
  }
  requestBackgroundTerminalWorktreeMount({ worktreeId: targetWorktreeId })
  let targetBrowserPageId = browserPageId ?? null
  if (!targetBrowserPageId) {
    const browserTabs = store.browserTabsByWorktree[targetWorktreeId] ?? []
    const activeWorkspaceId = store.activeBrowserTabIdByWorktree[targetWorktreeId] ?? null
    const workspace =
      browserTabs.find((tab) => tab.id === activeWorkspaceId) ?? browserTabs[0] ?? null
    targetBrowserPageId =
      workspace?.activePageId ?? workspace?.pageIds?.[0] ?? workspace?.id ?? null
  }
  if (!targetBrowserPageId) {
    return
  }

  releaseBrowserAutomationBootstrapLease(targetBrowserPageId)
  const token = acquireBrowserAutomationVisibility(targetBrowserPageId)
  const timer = window.setTimeout(() => {
    releaseBrowserAutomationBootstrapLease(targetBrowserPageId)
  }, BROWSER_AUTOMATION_BOOTSTRAP_LEASE_MS)
  browserAutomationBootstrapLeaseByPageId.set(targetBrowserPageId, { token, timer })
}
