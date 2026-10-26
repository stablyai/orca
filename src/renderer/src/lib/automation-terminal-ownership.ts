import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import '@/store/slices/agent-status'
import { collectSleepingAgentSessionRecordsForWorktree } from '@/store/slices/agent-status/agent-status-recovery-collection'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { readLastTerminalInputAt } from './terminal-input-activity-coalescing'

export type AutomationTerminalOwnershipStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previousState: AppState) => void) => () => void
}

/** How finalize retired the run's terminal; null when it left the terminal as it was. */
export type AutomationTerminalRetirement = 'closed' | 'hibernated' | null

export type AutomationTerminalOwnership = {
  /** `preservePane` sleeps a resumable pane in place instead of closing its tab. */
  finalize: (options: { preservePane: boolean }) => Promise<AutomationTerminalRetirement>
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

function canHibernateOwnedPane(
  state: AppState,
  args: Pick<CreateAutomationTerminalOwnershipArgs, 'worktreeId' | 'tabId' | 'paneKey' | 'ptyId'>
): boolean {
  // Why: a run that ended by exiting has no process left to stop in place.
  if (!(state.ptyIdsByTabId[args.tabId] ?? []).includes(args.ptyId)) {
    return false
  }
  return Boolean(
    collectSleepingAgentSessionRecordsForWorktree(state, args.worktreeId, {
      paneKeys: [args.paneKey],
      captureMode: 'completed-agent-hibernation'
    })[args.paneKey]
  )
}

export function createAutomationTerminalOwnership(
  args: CreateAutomationTerminalOwnershipArgs
): AutomationTerminalOwnership {
  let consumed = false
  let userTookOver = false
  // Include coalesced pending keystrokes or a recent user takeover can be missed.
  const inputAtLaunch = readLastTerminalInputAt(
    args.store.getState().lastTerminalInputAtByPaneKey,
    args.paneKey
  )
  const observeTakeover = (): void => {
    const state = args.store.getState()
    if (
      (state.activeWorktreeId === args.worktreeId &&
        state.activeTabId === args.tabId &&
        state.activeTabType === 'terminal') ||
      readLastTerminalInputAt(state.lastTerminalInputAtByPaneKey, args.paneKey) !== inputAtLaunch
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
    finalize: async ({ preservePane }) => {
      if (consumed) {
        return null
      }
      // Consume before identity checks: completion and exit can race to retire the same session.
      consumed = true
      unsubscribe()
      observeTakeover()
      if (args.runtimeKind !== 'desktop' || isRemoteRuntimePtyId(args.ptyId) || userTookOver) {
        return null
      }
      const state = args.store.getState()
      const leafId = parsePaneKey(args.paneKey)?.leafId
      if (!leafId || !isOwnedTabIdentityCurrent(state, args)) {
        return null
      }
      if (preservePane && canHibernateOwnedPane(state, args)) {
        try {
          // Why: sleeping keeps the tab and its resume record, so opening the run resumes it.
          await state.shutdownCompletedAgentPaneForHibernation(args.worktreeId, {
            paneKey: args.paneKey,
            tabId: args.tabId,
            leafId,
            ptyId: args.ptyId
          })
        } catch (error) {
          // Failed stop rolls back to a live agent; closing would discard the session it preserved.
          console.error('[automations] Failed to hibernate owned automation terminal:', error)
          return null
        }
        return 'hibernated'
      }
      try {
        // Use closeTab’s provider/pane teardown authority rather than adding a second direct-kill path.
        state.closeTab(args.tabId, { recordInteraction: false, reason: 'cleanup' })
      } catch (error) {
        // A throwing close leaves the terminal live; retain its valid identity and report not-closed.
        console.error('[automations] Failed to close owned automation terminal:', error)
        return null
      }
      return 'closed'
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
