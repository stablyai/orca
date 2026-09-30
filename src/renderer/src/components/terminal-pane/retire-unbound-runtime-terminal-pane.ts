import { resolveTerminalHostOwnership } from '@/lib/terminal-worktree-route'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  buildTerminalTabRetirementPlan,
  getTerminalPtyOwnershipIdentity
} from '@/store/slices/terminal-tab-retirement'
import { startTerminalTabProviderRetirement } from '@/store/terminals/terminal-tab-close-providers'
import {
  terminalPaneHasOtherOwner,
  type UnboundTerminalPaneRetirement
} from './terminal-pane-retirement-ownership'

/** An exact scoped handle authorizes close; a native hint cannot name its incarnation. */
export function retireUnboundRuntimeTerminalPane(args: UnboundTerminalPaneRetirement): void {
  const { getState, tabId, leafId, transport } = args
  if (!transport || transport.getPtyId()) {
    return
  }
  const state = getState()
  const requestedPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  const remote = requestedPtyId ? parseRemoteRuntimePtyId(requestedPtyId) : null
  const environmentId = remote?.environmentId?.trim()
  if (!requestedPtyId || !remote?.handle || !environmentId) {
    return
  }
  const plan = buildTerminalTabRetirementPlan(state, tabId)
  const identity = getTerminalPtyOwnershipIdentity(state, requestedPtyId, plan.worktreeId)
  const terminal = plan.runtimeTerminals.find(
    (candidate) =>
      getTerminalPtyOwnershipIdentity(state, candidate.ptyId, plan.worktreeId) === identity
  )
  const ownerIsCurrent = (): boolean => {
    const owner = resolveTerminalHostOwnership(getState(), plan.worktreeId, 'teardown')
    return owner.kind === 'runtime' && owner.runtimeEnvironmentId === environmentId
  }
  if (
    !terminal ||
    !ownerIsCurrent() ||
    terminalPaneHasOtherOwner(args, identity, plan.worktreeId, leafId)
  ) {
    return
  }
  startTerminalTabProviderRetirement({
    localPtyTeardownOwnedExternally: false,
    remoteCloseOwnedByHost: false,
    retirementPlan: {
      ...plan,
      ptyIds: [requestedPtyId],
      localOrSshPtyIds: [],
      runtimeTerminals: [{ ...terminal, environmentId }],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    },
    state,
    tabId,
    canRetireRuntimeTerminal: () =>
      ownerIsCurrent() && !terminalPaneHasOtherOwner(args, identity, plan.worktreeId)
  })
}
