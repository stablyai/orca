import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'

export type OpenSpotlightTerminalTabArgs = {
  repoId: string
  /** When true, switch to the main worktree's workspace and focus the tab —
   *  the "jump to server" gesture. When false, just make sure the tab exists
   *  without pulling the user away from their current workspace. */
  reveal: boolean
}

/**
 * Open (or reveal) the repo's single "Spotlight" terminal: a terminal tab in
 * the MAIN worktree's workspace whose cwd is the repository root — the fixed
 * home of the user's dev server. One per repo: activation/takeover from any
 * workspace reuses it, so the server and its log capture never move.
 */
export function openSpotlightTerminalTab({
  repoId,
  reveal
}: OpenSpotlightTerminalTabArgs): { tabId: string } | null {
  const store = useAppStore.getState()
  const mainWorktree = store.worktreesByRepo[repoId]?.find((entry) => entry.isMainWorktree)
  if (!mainWorktree) {
    return null
  }
  const worktreeId = mainWorktree.id

  const mainTabs = store.tabsByWorktree[worktreeId] ?? []
  const existing = mainTabs.find((tab) => tab.spotlightRepoRoot)
  if (existing) {
    if (existing.ptyId === null) {
      // The tab survived but its PTY died (or was never spawned after a
      // session restore); make sure the respawn lands in the repo root again.
      store.queueTabInitialCwd(existing.id, mainWorktree.path)
    }
    if (reveal) {
      activateAndRevealWorktree(worktreeId)
      store.setActiveTabForWorktree(worktreeId, existing.id)
      store.setActiveTabType('terminal')
    }
    return { tabId: existing.id }
  }

  // The user often already has a terminal running the server at the root —
  // adopt it instead of opening an empty duplicate next to it. Every terminal
  // in the main workspace already has the root as cwd, so adoption is safe.
  const activeMainTabId = store.activeTabIdByWorktree[worktreeId]
  const adopted = mainTabs.find((tab) => tab.id === activeMainTabId) ?? mainTabs[0]
  if (adopted) {
    store.markTabSpotlightRepoRoot(adopted.id)
    store.setTabCustomTitle(
      adopted.id,
      translate('auto.lib.open.spotlight.terminal.tab.title', 'Spotlight'),
      { recordInteraction: false }
    )
    if (adopted.ptyId) {
      // The PTY already exists, so the updateTabPtyId capture hook won't fire
      // for it — register the log mirror directly.
      void window.api.spotlight?.setLogPty?.({ repoId, ptyId: adopted.ptyId })
    }
    if (reveal) {
      activateAndRevealWorktree(worktreeId)
      store.setActiveTabForWorktree(worktreeId, adopted.id)
      store.setActiveTabType('terminal')
    }
    return { tabId: adopted.id }
  }

  const tab = store.createTab(worktreeId, undefined, undefined, {
    spotlightRepoRoot: true
  })
  store.queueTabInitialCwd(tab.id, mainWorktree.path)
  // customTitle wins over OSC title updates, so the label sticks.
  store.setTabCustomTitle(
    tab.id,
    translate('auto.lib.open.spotlight.terminal.tab.title', 'Spotlight'),
    { recordInteraction: false }
  )

  // Why: persist tab-bar order with the new terminal appended. Without this,
  // reconcileTabOrder falls back to terminals-first when the stored order is
  // unset, jumping the new tab to index 0.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  if (reveal) {
    activateAndRevealWorktree(worktreeId)
    fresh.setActiveTabForWorktree(worktreeId, tab.id)
    fresh.setActiveTabType('terminal')
  }

  return { tabId: tab.id }
}
