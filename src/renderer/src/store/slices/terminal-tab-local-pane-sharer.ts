import { isPositivelyLocalSourceWorktree } from '@/lib/terminal-worktree-route'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type {
  getTerminalPtyOwnershipIdentity,
  TerminalTabRetirementState
} from './terminal-tab-retirement'

/**
 * D17: a host-stamped tab's PTY is shared only with a pane the user sees in a group of a
 * positively local worktree; mirror, index and stale provider records never hold its handle open.
 */
export function isLocalPaneSharer(
  state: TerminalTabRetirementState,
  ownerTabId: string,
  ownerWorktreeId: string,
  identity: string,
  // Why injected: the planner owns PTY identity; importing it here would close a runtime cycle.
  identityOf: typeof getTerminalPtyOwnershipIdentity
): boolean {
  const unified = state.unifiedTabsByWorktree[ownerWorktreeId]?.find(
    (tab) => tab.entityId === ownerTabId
  )
  const layout = state.terminalLayoutsByTabId[ownerTabId]
  return (
    isPositivelyLocalSourceWorktree(state, ownerWorktreeId) &&
    (state.groupsByWorktree?.[ownerWorktreeId] ?? []).some((group) =>
      group.tabOrder.includes(unified?.id ?? '')
    ) &&
    collectLayoutLeafIdsInOrder(layout?.root).some((leafId) => {
      const ptyId = layout?.ptyIdsByLeafId?.[leafId]
      return ptyId !== undefined && identityOf(state, ptyId, ownerWorktreeId) === identity
    })
  )
}
