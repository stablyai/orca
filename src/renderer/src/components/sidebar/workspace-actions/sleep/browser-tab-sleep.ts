// Sleep never changes a workspace's tab layout (NEW-01). Its browser tabs stay where they are, in
// the same order with the same active tab; only their pages are dropped to free memory, and the
// workspace's tabs are marked asleep so they no longer count as activity (an asleep workspace still
// reads as asleep and hides with "Hide sleeping"). Opening the workspace again wakes them: each
// page reloads in place when it is shown. A remote desktop tab's own chrome reconnects it after a
// wake. The mark lives outside the layout (asleepBrowserWorktreeIds), so sleep writes no layout.
import { useAppStore } from '@/store'
import { destroyWorktreeBrowserGuests } from '@/store/slices/browser/cleanup/browser-webview-cleanup'
import type { BrowserWorkspace } from '../../../../../../shared/browser-workspace-types'

type BrowserTabsByWorktree = Record<string, BrowserWorkspace[]>

let cache: {
  tabs: BrowserTabsByWorktree
  asleep: Record<string, number>
  awake: BrowserTabsByWorktree
} | null = null

/**
 * The browser tabs that count as activity: every workspace's, minus those Sleep put to rest.
 * Same object back while neither input changes, so store selectors stay stable.
 */
export function selectAwakeBrowserTabsByWorktree(state: {
  browserTabsByWorktree: BrowserTabsByWorktree
  asleepBrowserWorktreeIds?: Record<string, number>
}): BrowserTabsByWorktree {
  const tabs = state.browserTabsByWorktree
  const asleep = state.asleepBrowserWorktreeIds
  if (!asleep || Object.keys(asleep).length === 0) {
    return tabs
  }
  if (cache && cache.tabs === tabs && cache.asleep === asleep) {
    return cache.awake
  }
  const awake: BrowserTabsByWorktree = {}
  for (const [worktreeId, worktreeTabs] of Object.entries(tabs)) {
    if (!asleep[worktreeId]) {
      awake[worktreeId] = worktreeTabs
    }
  }
  cache = { tabs, asleep, awake }
  return awake
}

// Pages a host ran (an Orca Cloud VM's browser) are gone after the VM sleeps. When such a page is
// reported missing after the wake, its tab opens a new page at the same URL instead of closing.
const reopenAfterSleep = new Set<string>()

/** True once per slept page: the pane recreates the host page instead of closing the tab. */
export function consumeReopenAfterSleep(browserPageId: string): boolean {
  return reopenAfterSleep.delete(browserPageId)
}

/** Sleep: drop the pages, keep the tabs, mark the workspace's tabs asleep. */
export function sleepWorktreeBrowserTabs(worktreeId: string, now: number = Date.now()): void {
  const state = useAppStore.getState()
  for (const tab of state.browserTabsByWorktree[worktreeId] ?? []) {
    reopenAfterSleep.add(tab.id)
    for (const page of state.browserPagesByWorkspace[tab.id] ?? []) {
      reopenAfterSleep.add(page.id)
    }
  }
  destroyWorktreeBrowserGuests(
    state.browserTabsByWorktree,
    state.browserPagesByWorkspace,
    worktreeId
  )
  if ((state.browserTabsByWorktree[worktreeId] ?? []).length === 0) {
    return
  }
  useAppStore.setState((s) => ({
    asleepBrowserWorktreeIds: { ...s.asleepBrowserWorktreeIds, [worktreeId]: now }
  }))
}

/** The workspace is open again: its tabs count as activity once more (pages reload when shown). */
export function wakeWorktreeBrowserTabs(worktreeId: string): void {
  if (!useAppStore.getState().asleepBrowserWorktreeIds?.[worktreeId]) {
    return
  }
  useAppStore.setState((s) => {
    const next = { ...s.asleepBrowserWorktreeIds }
    delete next[worktreeId]
    return { asleepBrowserWorktreeIds: next }
  })
}

/** Wakes a workspace's asleep tabs whenever it becomes the active one. */
export function installBrowserTabWakeOnOpen(): () => void {
  let previous = useAppStore.getState().activeWorktreeId
  if (previous) {
    wakeWorktreeBrowserTabs(previous)
  }
  return useAppStore.subscribe((state) => {
    if (state.activeWorktreeId === previous) {
      return
    }
    previous = state.activeWorktreeId
    if (previous) {
      wakeWorktreeBrowserTabs(previous)
    }
  })
}
