import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'

export type AutomationTerminalOwnershipStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previousState: AppState) => void) => () => void
}

export type AutomationTerminalOwnership = {
  finalize: () => boolean
  release: () => void
}

type CreateAutomationTerminalOwnershipArgs = {
  store: AutomationTerminalOwnershipStore
  worktreeId: string
  tabId: string
  paneKey: string
  ptyId: string
  tabCreatedAt: number
  runtimeKind: 'desktop' | 'environment'
}

function isOwnedTabIdentityCurrent(
  state: AppState,
  args: Omit<CreateAutomationTerminalOwnershipArgs, 'store' | 'runtimeKind'>
): boolean {
  const parsedPane = parsePaneKey(args.paneKey)
  if (!parsedPane || parsedPane.tabId !== args.tabId) {
    return false
  }
  const matchingTabs = Object.entries(state.tabsByWorktree).flatMap(([worktreeId, tabs]) =>
    tabs.filter((tab) => tab.id === args.tabId).map((tab) => ({ tab, worktreeId }))
  )
  const match = matchingTabs[0]
  if (
    matchingTabs.length !== 1 ||
    !match ||
    match.worktreeId !== args.worktreeId ||
    match.tab.worktreeId !== args.worktreeId ||
    match.tab.createdAt !== args.tabCreatedAt
  ) {
    return false
  }
  if (match.tab.ptyId !== null && match.tab.ptyId !== args.ptyId) {
    return false
  }
  if ((state.ptyIdsByTabId[args.tabId] ?? []).some((ptyId) => ptyId !== args.ptyId)) {
    return false
  }
  const layout = state.terminalLayoutsByTabId[args.tabId]
  const root = layout?.root
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (
    !layout ||
    !root ||
    root.type !== 'leaf' ||
    root.leafId !== parsedPane.leafId ||
    layout.activeLeafId !== parsedPane.leafId ||
    Object.keys(ptyIdsByLeafId ?? {}).some((leafId) => leafId !== parsedPane.leafId)
  ) {
    return false
  }
  const layoutPtyId = ptyIdsByLeafId?.[parsedPane.leafId]
  return layoutPtyId === undefined || layoutPtyId === args.ptyId
}

export function createAutomationTerminalOwnership(
  args: CreateAutomationTerminalOwnershipArgs
): AutomationTerminalOwnership {
  let consumed = false
  let userTookOver = false
  const inputAtLaunch = args.store.getState().lastTerminalInputAtByPaneKey[args.paneKey]
  const observeTakeover = (): void => {
    const state = args.store.getState()
    if (
      (state.activeWorktreeId === args.worktreeId &&
        state.activeTabId === args.tabId &&
        state.activeTabType === 'terminal') ||
      state.lastTerminalInputAtByPaneKey[args.paneKey] !== inputAtLaunch
    ) {
      userTookOver = true
    }
  }
  const unsubscribe = args.store.subscribe(observeTakeover)
  observeTakeover()

  const release = (): void => {
    if (consumed) {
      return
    }
    consumed = true
    unsubscribe()
  }

  return {
    release,
    finalize: () => {
      if (consumed) {
        return false
      }
      // Why: completion and exit can race; consume before any identity check so
      // only the first successful-result path can retire this exact session.
      consumed = true
      unsubscribe()
      observeTakeover()
      if (args.runtimeKind !== 'desktop' || args.ptyId.startsWith('remote:') || userTookOver) {
        return false
      }
      const state = args.store.getState()
      if (!isOwnedTabIdentityCurrent(state, args)) {
        return false
      }
      try {
        // Why: closeTab centrally owns provider shutdown and pane removal; a
        // direct kill here would create a second teardown authority.
        state.closeTab(args.tabId, { recordInteraction: false, reason: 'cleanup' })
      } catch (error) {
        // Why: a throwing close leaves the terminal alive; report not-closed so
        // the run keeps its (still-valid) terminal identity and no stale clear runs.
        console.error('[automations] Failed to close owned automation terminal:', error)
        return false
      }
      return true
    }
  }
}

export function bindAutomationTerminal(
  tab: TerminalTab,
  paneKey: string,
  ptyId: string,
  runtimeKind: 'local' | 'environment',
  title?: string
): AutomationTerminalOwnership | null {
  const parsedPane = parsePaneKey(paneKey)
  if (!parsedPane || parsedPane.tabId !== tab.id) {
    throw new Error('Automation terminal pane identity is invalid.')
  }
  const store = useAppStore.getState()
  if (title) {
    store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
  }
  store.updateTabPtyId(tab.id, ptyId)
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(parsedPane.leafId, ptyId))
  const ownership =
    runtimeKind === 'local'
      ? createAutomationTerminalOwnership({
          store: useAppStore,
          worktreeId: tab.worktreeId,
          tabId: tab.id,
          paneKey,
          ptyId,
          tabCreatedAt: tab.createdAt,
          runtimeKind: 'desktop'
        })
      : null
  return ownership
}
