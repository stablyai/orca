import { createTabGroupScopedState } from '@/lib/workspace/tabs/tab-group-scoped-state'

// A group's launch surface refreshes each host once; a remount after its layout was released isn't a new surface.
const observedTargetsByGroup = createTabGroupScopedState<Set<string>>()

export function observedAgentTargetsForGroup(worktreeId: string, groupId: string): Set<string> {
  const existing = observedTargetsByGroup.get(worktreeId, groupId)
  if (existing) {
    return existing
  }
  const created = new Set<string>()
  observedTargetsByGroup.set(worktreeId, groupId, created)
  return created
}
