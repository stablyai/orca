import {
  getTerminalPtyOwnershipIdentity,
  type TerminalTabRetirementPlan,
  type TerminalTabRetirementState
} from './terminal-tab-retirement'

export function reserveTerminalRetirementTeardowns(
  state: TerminalTabRetirementState,
  plan: TerminalTabRetirementPlan,
  scheduledPtyOwners: Set<string>
): { plan: TerminalTabRetirementPlan; newlyScheduledPtyOwners: string[] } {
  const cleanupOnlyPtyIds = new Set(plan.cleanupOnlyPtyIds)
  const newlyScheduledPtyOwners: string[] = []
  const reserve = (ptyId: string): boolean => {
    const owner = getTerminalPtyOwnershipIdentity(state, ptyId, plan.worktreeId)
    if (scheduledPtyOwners.has(owner)) {
      cleanupOnlyPtyIds.add(ptyId)
      return false
    }
    scheduledPtyOwners.add(owner)
    newlyScheduledPtyOwners.push(owner)
    return true
  }
  return {
    plan: {
      ...plan,
      localOrSshPtyIds: plan.localOrSshPtyIds.filter(reserve),
      runtimeTerminals: plan.runtimeTerminals.filter((terminal) => reserve(terminal.ptyId)),
      cleanupOnlyPtyIds: [...cleanupOnlyPtyIds]
    },
    newlyScheduledPtyOwners
  }
}
