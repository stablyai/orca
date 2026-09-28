import {
  buildTerminalTabRetirementPlan,
  getTerminalPtyOwnershipIdentity
} from '@/store/slices/terminal-tab-retirement'
import { startTerminalTabProviderRetirement } from '@/store/terminals/terminal-tab-close-providers'
import {
  terminalPaneHasOtherOwner,
  type UnboundTerminalPaneRetirement
} from './terminal-pane-retirement-ownership'

/** Capture explicit split-close intent before the durable leaf binding is removed. */
export function retireUnboundIpcTerminalPane(args: UnboundTerminalPaneRetirement): void {
  const { getState, tabId, leafId, transport } = args
  if (!transport || transport.getPtyId()) {
    return
  }
  const state = getState()
  const requestedPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  if (!requestedPtyId) {
    return
  }
  const plan = buildTerminalTabRetirementPlan(state, tabId)
  const identity = getTerminalPtyOwnershipIdentity(state, requestedPtyId, plan.worktreeId)
  const ptyId = plan.localOrSshPtyIds.find(
    (candidate) => getTerminalPtyOwnershipIdentity(state, candidate, plan.worktreeId) === identity
  )
  // Paired-runtime handles and unresolved routes cannot authorize an IPC kill.
  if (!ptyId) {
    return
  }
  const hasOtherOwner = (excludedLeafId?: string): boolean =>
    terminalPaneHasOtherOwner(args, identity, plan.worktreeId, excludedLeafId)
  if (hasOtherOwner(leafId)) {
    return
  }
  const retirementPlan = {
    ...plan,
    ptyIds: [ptyId],
    localOrSshPtyIds: [ptyId],
    runtimeTerminals: [],
    cleanupOnlyPtyIds: [],
    sharedPtyIds: [],
    unroutablePtyIds: []
  }
  const requestRetirement = (): void => {
    startTerminalTabProviderRetirement({
      localPtyTeardownOwnedExternally: false,
      remoteCloseOwnedByHost: false,
      retirementPlan,
      state: getState(),
      tabId
    })
  }
  transport.destroy?.({
    onAbandonedConnect: (returnedPtyId) => {
      if (returnedPtyId !== requestedPtyId) {
        return false
      }
      // A replacement can own even this same leaf by the time the reply arrives.
      if (!hasOtherOwner()) {
        requestRetirement()
      }
      return true
    }
  })
  requestRetirement()
}
