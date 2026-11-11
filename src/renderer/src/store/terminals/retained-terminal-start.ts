import { retainedStartSupersedes } from './retained-terminal-start-lifecycle'
import { useAppStore } from '@/store/index'
import { addSplitLeafToLayout } from '@/hooks/ipc-events/terminal-command-state'
import { wasAgentLaunchPaneClosedByUser } from '@/lib/agent-session/launch/pane/agent-launch-pane-closes'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  retainedTerminalStart,
  readRetainedTerminalStart,
  type RetainedTerminalStart
} from '../../../../shared/workspace-layout/retained-terminal-start'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
export { installRetainedTerminalDestination } from './retained-terminal-destination-installation'
export type { RetainedDestinationDisposition } from './retained-terminal-destination-installation'
import type { TabSplitTarget } from '../slices/tabs/tabs-slice-contract'
import type { AppState } from '../types'
import { insertUnifiedTabAfterAnchor } from '@/lib/workspace/tabs/unified-tab-anchor-insertion'
import { receivedSessionTabsFrameSequence } from '@/runtime/web-session-tabs-sync/state'

export function retainedStartFromRpcError(error: unknown): RetainedTerminalStart | null {
  return error instanceof RuntimeRpcCallError
    ? readRetainedTerminalStart(error.response.error.data)
    : null
}

/** Install before exposing an unbound leaf to synchronous mount subscribers. */
export function holdRetainedTerminalStart(
  outcome: RetainedTerminalStart,
  addressed: RetainedProjectionAddress = {
    worktreeId: outcome.worktreeId,
    tabId: outcome.tabId,
    leafId: outcome.leafId
  }
): boolean {
  const parsed = retainedTerminalStart.safeParse(outcome)
  if (!parsed.success) {
    return false
  }
  const state = useAppStore.getState()
  if (!canHoldRetainedTerminalStart(state, outcome, addressed)) {
    return false
  }
  const { tabId, leafId } = addressed
  const paneKey = `${tabId}:${leafId}`
  const previous = state.terminalPaneStartsByPaneKey[paneKey]?.retainedTerminalStart
  state.terminalStartupAttempt?.settle(tabId, leafId)
  if (
    previous?.runtimeId === outcome.runtimeId &&
    previous.startSequence === outcome.startSequence &&
    previous.bindingGeneration === outcome.bindingGeneration &&
    previous.reason === outcome.reason &&
    previous.status === outcome.status
  ) {
    return true
  }
  useAppStore.setState({
    terminalPaneStartsByPaneKey: {
      ...state.terminalPaneStartsByPaneKey,
      [paneKey]: {
        status: outcome.status,
        reason: outcome.reason,
        retainedTerminalStart: outcome,
        ...(addressed.paired
          ? {
              retainedHostReceipt: {
                environmentId: addressed.paired.environmentId,
                pairingRevision: addressed.paired.pairingRevision,
                receivedFrame: receivedSessionTabsFrameSequence
              }
            }
          : {})
      }
    }
  })
  return true
}

export function canHoldRetainedTerminalStart(
  state: AppState,
  outcome: RetainedTerminalStart,
  addressed: RetainedProjectionAddress
): boolean {
  const { worktreeId, tabId, leafId } = addressed
  const owner = state.getTerminalTabOwnerWorktreeId?.(tabId)
  if (
    outcome.worktreeId !== worktreeId ||
    (addressed.paired
      ? !addressed.paired.current() ||
        addressed.paired.runtimeId !== outcome.runtimeId ||
        toWebTerminalSurfaceTabId(outcome.tabId) !== tabId
      : outcome.tabId !== tabId) ||
    outcome.leafId !== leafId ||
    (owner !== undefined && owner !== null && owner !== worktreeId) ||
    state.closedTerminalTabTombstonesByTabId[tabId]?.worktreeId === worktreeId ||
    wasAgentLaunchPaneClosedByUser(tabId, leafId) ||
    state.terminalStartupAttempt?.wasRetired(tabId, leafId) ||
    (state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] &&
      state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] !==
        state.terminalStartupAttempt?.historicalBinding(tabId, leafId))
  ) {
    return false
  }
  const paneKey = `${tabId}:${leafId}`
  const previous = state.terminalPaneStartsByPaneKey[paneKey]?.retainedTerminalStart
  return retainedStartSupersedes(previous, outcome)
}

export type RetainedProjectionAddress = {
  worktreeId: string
  tabId: string
  leafId: string
  paired?: {
    environmentId: string
    runtimeId: string
    pairingRevision: number | undefined
    current: () => boolean
  }
}

export function projectRetainedTerminalStart(
  outcome: RetainedTerminalStart,
  placement: {
    worktreeId?: string
    tabId?: string
    groupId?: string
    shell?: string
    cwd?: string
    viewMode?: 'terminal' | 'chat'
    split?: TabSplitTarget
    splitFromLeafId?: string
    splitDirection?: 'horizontal' | 'vertical'
    afterTabId?: string
    paired?: RetainedProjectionAddress['paired']
  } = {}
): boolean {
  const worktreeId = placement.worktreeId ?? outcome.worktreeId
  const tabId = placement.tabId ?? outcome.tabId
  const leafId = outcome.leafId
  const before = useAppStore.getState()
  const existing = before.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  const layout = before.terminalLayoutsByTabId[tabId]
  if (
    placement.split &&
    !before.groupsByWorktree[worktreeId]?.some(
      (group) => group.id === placement.split!.sourceGroupId
    )
  ) {
    return false
  }
  if (
    placement.splitFromLeafId &&
    (!existing || !collectLeafIds(layout?.root).includes(placement.splitFromLeafId))
  ) {
    return false
  }
  if (
    !holdRetainedTerminalStart(outcome, { worktreeId, tabId, leafId, paired: placement.paired })
  ) {
    return false
  }
  const current = useAppStore.getState()
  if (placement.paired && !placement.paired.current()) {
    return false
  }
  if (
    current.closedTerminalTabTombstonesByTabId[tabId]?.worktreeId === worktreeId ||
    current.terminalStartupAttempt?.wasRetired(tabId, leafId)
  ) {
    return false
  }
  const currentTab = current.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  const currentLayout = current.terminalLayoutsByTabId[tabId]
  if (!currentTab) {
    current.createTab(worktreeId, placement.groupId, placement.shell, {
      id: tabId,
      initialLeafId: leafId,
      layoutAlreadyAdmitted: true,
      ...(placement.paired ? { mirroredHostTab: true } : {}),
      activate: false,
      ...(placement.cwd ? { startupCwd: placement.cwd } : {}),
      ...(placement.viewMode ? { viewMode: placement.viewMode } : {}),
      ...(placement.split &&
      !current.groupsByWorktree[worktreeId]?.some((g) => g.id === placement.groupId)
        ? { split: { ...placement.split, activate: false } }
        : {})
    })
  } else if (!collectLeafIds(currentLayout?.root).includes(leafId)) {
    if (
      !placement.splitFromLeafId ||
      !collectLeafIds(currentLayout?.root).includes(placement.splitFromLeafId)
    ) {
      return false
    }
    current.setTabLayout(
      tabId,
      addSplitLeafToLayout(
        currentLayout,
        placement.splitFromLeafId,
        leafId,
        undefined,
        placement.splitDirection ?? 'horizontal',
        undefined,
        false
      )
    )
  }
  if (placement.afterTabId) {
    const rows = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
    const anchor = rows.find(
      (row) => row.id === placement.afterTabId || row.entityId === placement.afterTabId
    )
    const created = rows.find((row) => row.contentType === 'terminal' && row.entityId === tabId)
    if (anchor && created) {
      insertUnifiedTabAfterAnchor(worktreeId, created.id, anchor.id)
    }
  }
  return true
}
