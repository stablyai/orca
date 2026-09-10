import { useAppStore } from '@/store'
import { appendTerminalToPersistedTabOrder } from '@/components/tab-bar/reconcile-order'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'

export type OpenSpotlightTerminalTabResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: 'no-main-worktree' }

export type OpenSpotlightTerminalTabArgs = {
  repoId: string
  /** When true, switch to the main worktree's workspace and focus the tab —
   *  the "jump to server" gesture. When false, just make sure the tab exists
   *  without pulling the user away from their current workspace. */
  reveal: boolean
}

/** A terminal that already runs the server (or a plain shell) at the root is
 *  safe to adopt as the Spotlight terminal. An agent/chat tab is NOT — adopting
 *  it would rename it, mirror its transcript as "server logs", and expose it to
 *  the Ctrl-C restart trigger. */
function isAdoptableTerminal(tab: { viewMode?: string; launchAgent?: unknown }): boolean {
  return tab.viewMode !== 'chat' && tab.launchAgent === undefined
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
}: OpenSpotlightTerminalTabArgs): OpenSpotlightTerminalTabResult {
  const store = useAppStore.getState()
  const mainWorktree = store.worktreesByRepo[repoId]?.find((entry) => entry.isMainWorktree)
  if (!mainWorktree) {
    return { ok: false, reason: 'no-main-worktree' }
  }
  const worktreeId = mainWorktree.id

  const mainTabs = store.tabsByWorktree[worktreeId] ?? []
  const existing = mainTabs.find((tab) => tab.spotlightRepoRoot)
  if (existing) {
    if (existing.ptyId === null) {
      // The tab survived but its PTY died (or was never spawned after a
      // session restore); make sure the respawn lands in the repo root again.
      store.queueTabInitialCwd(existing.id, mainWorktree.path)
    } else {
      // Re-register the log mirror. After an off→on cycle deactivate tore the
      // capture down, and the tab's still-live PTY won't fire updateTabPtyId
      // (its ptyId is unchanged), so nothing else would restart mirroring —
      // the second session would append to .orca/spotlight.log nowhere.
      void window.api.spotlight?.setLogPty?.({ repoId, ptyId: existing.ptyId })
    }
    if (reveal) {
      activateAndRevealWorktree(worktreeId)
      store.setActiveTabForWorktree(worktreeId, existing.id)
      store.setActiveTabType('terminal')
    }
    return { ok: true, tabId: existing.id }
  }

  // The user often already has a plain terminal running the server at the root
  // — adopt it instead of opening an empty duplicate. Never adopt an agent/chat
  // tab. Every terminal in the main workspace has the root as its spawn cwd.
  const activeMainTabId = store.activeTabIdByWorktree[worktreeId]
  const preferred = mainTabs.find((tab) => tab.id === activeMainTabId)
  const adopted =
    preferred && isAdoptableTerminal(preferred)
      ? preferred
      : mainTabs.find((tab) => isAdoptableTerminal(tab))
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
    return { ok: true, tabId: adopted.id }
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
  appendTerminalToPersistedTabOrder(useAppStore.getState(), worktreeId, tab.id)

  if (reveal) {
    activateAndRevealWorktree(worktreeId)
    useAppStore.getState().setActiveTabForWorktree(worktreeId, tab.id)
    // setActiveTabType targets the ACTIVE worktree's pane, so only flip it when
    // revealing — otherwise a reveal:false activation from a feature workspace
    // would yank the user's current pane to the terminal.
    useAppStore.getState().setActiveTabType('terminal')
  }

  return { ok: true, tabId: tab.id }
}
