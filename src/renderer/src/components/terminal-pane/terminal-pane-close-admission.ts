import type { AppState } from '@/store/types'
import {
  buildTerminalTabRetirementPlan,
  getTerminalPtyOwnershipIdentity
} from '@/store/slices/terminal-tab-retirement'
import { locateTerminalTab } from '@/store/terminals/terminal-tab-location'
import { resolveTerminalHostOwnership } from '@/lib/terminal-worktree-route'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { TerminalPaneBindingController } from './use-terminal-pane-layout-bindings'

export function capturePendingTerminalPaneClose(
  controller: Pick<TerminalPaneBindingController, 'managerRef' | 'paneTransportsRef' | 'tabId'>,
  paneId: number,
  getState: () => AppState
): { ptyId: string; isCurrent: () => boolean } | undefined {
  const { managerRef, paneTransportsRef, tabId } = controller
  const manager = managerRef.current
  const transport = paneTransportsRef.current.get(paneId)
  const leafId = manager?.getLeafId(paneId)
  const state = getState()
  const ptyId = leafId && state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  if (!manager || !transport || transport.getPtyId() || !leafId || !ptyId) {
    return undefined
  }
  const plan = buildTerminalTabRetirementPlan(state, tabId)
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  const owner = resolveTerminalHostOwnership(state, plan.worktreeId, 'teardown')
  const identity = getTerminalPtyOwnershipIdentity(state, ptyId, plan.worktreeId)
  const isIdentity = (id: string): boolean =>
    getTerminalPtyOwnershipIdentity(state, id, plan.worktreeId) === identity
  if (
    !plan.localOrSshPtyIds.some(isIdentity) &&
    !(
      environmentId &&
      owner.kind === 'runtime' &&
      owner.runtimeEnvironmentId === environmentId &&
      plan.runtimeTerminals.some((terminal) => isIdentity(terminal.ptyId))
    )
  ) {
    return undefined
  }
  const originalTab = locateTerminalTab(state.tabsByWorktree, tabId)?.tab
  const createdAt = originalTab?.createdAt
  const generation = originalTab?.generation ?? 0
  const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  return {
    ptyId,
    isCurrent: () => {
      const current = getState()
      const currentTab = locateTerminalTab(current.tabsByWorktree, tabId)
      const currentOwner = resolveTerminalHostOwnership(current, plan.worktreeId, 'teardown')
      const currentPtyId = current.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
      const boundId = transport.getPtyId()
      // A split confirmation cannot authorize a replacement pane or a later whole-tab close.
      return (
        managerRef.current === manager &&
        manager.getPanes().length > 1 &&
        manager.getPanes().some((pane) => pane.id === paneId && pane.leafId === leafId) &&
        manager.getLeafId(paneId) === leafId &&
        paneTransportsRef.current.get(paneId) === transport &&
        currentTab?.worktreeId === plan.worktreeId &&
        currentTab?.tab.createdAt === createdAt &&
        (currentTab?.tab.generation ?? 0) === generation &&
        currentOwner.kind === owner.kind &&
        currentOwner.runtimeEnvironmentId === owner.runtimeEnvironmentId &&
        (!environmentId || getRuntimeEnvironmentRevision(environmentId) === pairingRevision) &&
        !!currentPtyId &&
        getTerminalPtyOwnershipIdentity(current, currentPtyId, plan.worktreeId) === identity &&
        (boundId === null ||
          getTerminalPtyOwnershipIdentity(current, boundId, plan.worktreeId) === identity)
      )
    }
  }
}
