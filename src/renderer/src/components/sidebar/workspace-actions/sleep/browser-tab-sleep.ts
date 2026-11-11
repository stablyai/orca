// Sleep never changes a workspace's tab layout (NEW-01). Its browser tabs stay where they are, in
// the same order with the same active tab; only their pages are dropped to free memory, and each
// tab is marked asleep so it no longer counts as activity (an asleep workspace still reads as
// asleep and hides with "Hide sleeping"). Opening the workspace again wakes the tabs: each page
// reloads in place when it is shown. A remote desktop tab's own chrome reconnects it after a wake.
import { useAppStore } from '@/store'
import { destroyWorktreeBrowserGuests } from '@/store/slices/browser/cleanup/browser-webview-cleanup'
import type { BrowserWorkspace } from '../../../../../../shared/browser-workspace-types'

/** Awake tabs are activity; a tab Sleep put to rest is not, until the workspace is opened again. */
export function isAwakeBrowserTab(tab: { sleptAt?: number | null }): boolean {
  return !tab.sleptAt
}

export function hasAwakeBrowserTab(
  tabs: readonly { sleptAt?: number | null }[] | null | undefined
): boolean {
  return (tabs ?? []).some(isAwakeBrowserTab)
}

function stamp(
  tabs: readonly BrowserWorkspace[],
  sleptAt: number | undefined
): BrowserWorkspace[] | null {
  let changed = false
  const next = tabs.map((tab) => {
    if ((tab.sleptAt ?? undefined) === sleptAt) {
      return tab
    }
    changed = true
    const copy: BrowserWorkspace = { ...tab }
    if (sleptAt === undefined) {
      delete copy.sleptAt
    } else {
      copy.sleptAt = sleptAt
    }
    return copy
  })
  return changed ? next : null
}

/** Sleep: drop the pages, keep the tabs, mark them asleep. */
export function sleepWorktreeBrowserTabs(worktreeId: string, now: number = Date.now()): void {
  const state = useAppStore.getState()
  destroyWorktreeBrowserGuests(
    state.browserTabsByWorktree,
    state.browserPagesByWorkspace,
    worktreeId
  )
  const next = stamp(state.browserTabsByWorktree[worktreeId] ?? [], now)
  if (next) {
    useAppStore.setState((s) => ({
      browserTabsByWorktree: { ...s.browserTabsByWorktree, [worktreeId]: next }
    }))
  }
}

/** The workspace is open again: its tabs count as activity once more (pages reload when shown). */
export function wakeWorktreeBrowserTabs(worktreeId: string): void {
  const tabs = useAppStore.getState().browserTabsByWorktree[worktreeId]
  if (!tabs || !tabs.some((tab) => tab.sleptAt)) {
    return
  }
  const next = stamp(tabs, undefined)
  if (next) {
    useAppStore.setState((s) => ({
      browserTabsByWorktree: { ...s.browserTabsByWorktree, [worktreeId]: next }
    }))
  }
}

/** Wakes a workspace's asleep tabs whenever it becomes the active one (also after an app restart). */
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
