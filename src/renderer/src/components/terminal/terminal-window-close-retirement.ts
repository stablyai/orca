import { useAppStore } from '@/store'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import {
  fetchWorkspaceSessionFromHosts,
  listKnownRuntimeHostIds
} from '@/lib/workspace-session-host-persistence'
import {
  buildTerminalTabRetirementPlans,
  type TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import { closeTerminalTab } from './terminal-tab-actions'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../../shared/renderer-shutdown-events'
import { getWorkspaceSessionPersistenceHostId } from '../../../../shared/workspace-session-persistence-host'
import { closeTerminalTabInWorkspaceSession } from '../../../../shared/workspace-session-terminal-tab-close'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { collectWindowSessionTerminalTabIds } from '../../../../shared/window-session-terminal-membership'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

type WindowTerminalCloseState = ReturnType<typeof useAppStore.getState>
type WindowTerminalCloseResult = 'confirmed' | 'blocked'

export type WindowTerminalCloseRetirementDependencies = {
  getState: () => WindowTerminalCloseState
  getWindowSessionState: () => Promise<WorkspaceSessionState>
  listOwnedProviderPtyIds: () => Promise<string[]>
  closeTab: (
    tabId: string,
    options: {
      force: true
      skipRunningProcessConfirm: true
      precomputedRetirementPlan: TerminalTabRetirementPlan
    }
  ) => void
  persistRetiredSessionTabs: (plans: readonly TerminalTabRetirementPlan[]) => Promise<void>
  cancelWindowClose: () => void
  dispatchBeforeUnload: () => boolean
  awaitCheckpoint: () => Promise<void>
  resetCheckpointAttempt: () => void
  confirmWindowClose: () => boolean | void
}

function findSessionTerminalWorktreeId(
  session: WorkspaceSessionState,
  tabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (
      tabs.some(
        (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
      )
    ) {
      return worktreeId
    }
  }
  return null
}

async function persistRetiredSessionTabs(
  plans: readonly TerminalTabRetirementPlan[]
): Promise<void> {
  const state = useAppStore.getState()
  const hostIds = new Set<ExecutionHostId>([
    LOCAL_EXECUTION_HOST_ID,
    ...listKnownRuntimeHostIds(state.repos),
    ...Object.values(state.restoredRuntimeHostIdByWorkspaceSessionKey).map(
      getWorkspaceSessionPersistenceHostId
    )
  ])
  for (const plan of plans) {
    for (const terminal of plan.runtimeTerminals) {
      if (terminal.environmentId) {
        hostIds.add(toRuntimeExecutionHostId(terminal.environmentId))
      }
    }
    const route = plan.worktreeId ? resolveTerminalWorktreeRoute(state, plan.worktreeId) : null
    if (route?.runtimeEnvironmentId) {
      hostIds.add(toRuntimeExecutionHostId(route.runtimeEnvironmentId))
    }
  }
  await Promise.all(
    [...hostIds].map(async (hostId) => {
      let session = await window.api.session.get(
        hostId === LOCAL_EXECUTION_HOST_ID ? undefined : hostId
      )
      let changed = false
      for (const plan of plans) {
        const result = closeTerminalTabInWorkspaceSession(
          session,
          findSessionTerminalWorktreeId(session, plan.tabId) ?? plan.worktreeId ?? '',
          plan.tabId
        )
        session = result.session
        changed ||= result.closed
      }
      if (changed) {
        await window.api.session.set(
          session,
          hostId === LOCAL_EXECUTION_HOST_ID ? undefined : hostId
        )
      }
    })
  )
  await window.api.session.flush()
}

function snapshotTerminalTabIds(state: WindowTerminalCloseState): string[] {
  return [
    ...collectWindowSessionTerminalTabIds({
      tabsByWorktree: state.tabsByWorktree,
      unifiedTabs: state.unifiedTabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      remoteSessionIdsByTabId: state.lastKnownRelayPtyIdByTabId
    })
  ]
}

function mergeWindowTerminalState(
  state: WindowTerminalCloseState,
  session: WorkspaceSessionState
): WindowTerminalCloseState {
  const tabsByWorktree = { ...session.tabsByWorktree }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    tabsByWorktree[worktreeId] = [
      ...new Map(
        [...(tabsByWorktree[worktreeId] ?? []), ...tabs].map((tab) => [tab.id, tab])
      ).values()
    ]
  }
  const unifiedTabsByWorktree = { ...session.unifiedTabs }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    unifiedTabsByWorktree[worktreeId] = [
      ...new Map(
        [...(unifiedTabsByWorktree[worktreeId] ?? []), ...tabs].map((tab) => [tab.id, tab])
      ).values()
    ]
  }
  return {
    ...state,
    tabsByWorktree,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      ...state.terminalLayoutsByTabId
    },
    lastKnownRelayPtyIdByTabId: {
      ...session.remoteSessionIdsByTabId,
      ...state.lastKnownRelayPtyIdByTabId
    }
  }
}

function defaultDependencies(): WindowTerminalCloseRetirementDependencies {
  return {
    getState: useAppStore.getState,
    listOwnedProviderPtyIds: () => window.api.pty.listOwnedProviderPtyIds(),
    getWindowSessionState: async () => {
      const state = useAppStore.getState()
      const session = await fetchWorkspaceSessionFromHosts(
        window.api.session,
        state.repos,
        Object.values(state.restoredRuntimeHostIdByWorkspaceSessionKey)
      )
      return session
    },
    closeTab: closeTerminalTab,
    persistRetiredSessionTabs,
    cancelWindowClose: () => window.api.ui.cancelWindowClose(),
    dispatchBeforeUnload: () =>
      window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
    awaitCheckpoint: () => window.api.app.awaitBeforeUnloadCheckpoint(),
    resetCheckpointAttempt: () =>
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT)),
    confirmWindowClose: () => window.api.ui.confirmWindowClose()
  }
}

let retirementInFlight: Promise<WindowTerminalCloseResult> | null = null

export function retireWindowTerminalTabsAndConfirmClose(
  dependencies: WindowTerminalCloseRetirementDependencies = defaultDependencies(),
  closeFencedProviderPtyIds: readonly string[] = []
): Promise<WindowTerminalCloseResult> {
  if (retirementInFlight) {
    return retirementInFlight
  }
  const run = async (): Promise<WindowTerminalCloseResult> => {
    let checkpointStarted = false
    let closeConfirmed = false
    try {
      const ownedProviderPtyIds = new Set([
        ...(await dependencies.listOwnedProviderPtyIds()),
        ...closeFencedProviderPtyIds
      ])
      const initialState = mergeWindowTerminalState(
        dependencies.getState(),
        await dependencies.getWindowSessionState()
      )
      const tabIds = snapshotTerminalTabIds(initialState)
      const plans = buildTerminalTabRetirementPlans(initialState, tabIds, ownedProviderPtyIds)
      for (const [tabId, plan] of plans) {
        const cleanupOnlyPtyIds = plan.unroutablePtyIds.filter(
          (ptyId) => !ownedProviderPtyIds.has(ptyId)
        )
        if (
          cleanupOnlyPtyIds.length > 0 &&
          plan.worktreeId === null &&
          Object.hasOwn(initialState.terminalLayoutsByTabId, tabId)
        ) {
          const movedPtyIds = new Set(cleanupOnlyPtyIds)
          plans.set(tabId, {
            ...plan,
            cleanupOnlyPtyIds: [...new Set([...plan.cleanupOnlyPtyIds, ...cleanupOnlyPtyIds])],
            unroutablePtyIds: plan.unroutablePtyIds.filter((ptyId) => !movedPtyIds.has(ptyId))
          })
        }
      }
      if (
        tabIds.some((tabId) => {
          const plan = plans.get(tabId)
          if (!plan || plan.unroutablePtyIds.length > 0) {
            return true
          }
          if (plan.worktreeId) {
            return !resolveTerminalWorktreeRoute(initialState, plan.worktreeId)
          }
          return (
            plan.localOrSshPtyIds.some((ptyId) => !ownedProviderPtyIds.has(ptyId)) ||
            plan.runtimeTerminals.some((terminal) => !terminal.environmentId)
          )
        })
      ) {
        return 'blocked'
      }
      for (const tabId of tabIds) {
        dependencies.closeTab(tabId, {
          force: true,
          skipRunningProcessConfirm: true,
          precomputedRetirementPlan: plans.get(tabId)!
        })
        if (snapshotTerminalTabIds(dependencies.getState()).includes(tabId)) {
          return 'blocked'
        }
      }
      await dependencies.persistRetiredSessionTabs([...plans.values()])
      if (!dependencies.dispatchBeforeUnload()) {
        dependencies.resetCheckpointAttempt()
        return 'blocked'
      }
      checkpointStarted = true
      await dependencies.awaitCheckpoint()
      if (snapshotTerminalTabIds(dependencies.getState()).length > 0) {
        dependencies.resetCheckpointAttempt()
        return 'blocked'
      }
      if (dependencies.confirmWindowClose() === false) {
        dependencies.resetCheckpointAttempt()
        return 'blocked'
      }
      closeConfirmed = true
      return 'confirmed'
    } catch (error) {
      if (checkpointStarted) {
        dependencies.resetCheckpointAttempt()
      }
      console.warn('[window-close] Terminal retirement did not complete', error)
      return 'blocked'
    } finally {
      if (!closeConfirmed) {
        dependencies.cancelWindowClose()
      }
    }
  }
  retirementInFlight = run()
  void retirementInFlight.finally(() => {
    retirementInFlight = null
  })
  return retirementInFlight
}
