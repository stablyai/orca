import type { AppState } from '@/store/types'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { isValidResolvedWorktreeLineageEdge } from '../../../../shared/resolved-worktree-lineage'
import { getProjectedWorktreeLineage } from './worktree-lineage-projection'

type Target = Pick<Worktree, 'id' | 'hostId' | 'instanceId'>
type State = Pick<AppState, 'worktreesByRepo' | 'worktreeLineageById'>

export function captureWorktreeDeleteLineage(state: State, targets: readonly Target[]) {
  const targetsById = new Map<string, Target[]>()
  for (const target of targets) {
    const entries = targetsById.get(target.id) ?? []
    entries.push(target)
    targetsById.set(target.id, entries)
  }
  const parentByChild = new Map<string, Target>()
  for (const target of targets) {
    const child = getWorktreeOnHostFromState(state, target.id, target.hostId)
    const lineage = child && getProjectedWorktreeLineage(child, state.worktreeLineageById)
    if (!child || !lineage) {
      continue
    }
    const parent = targetsById.get(lineage.parentWorktreeId)?.find((candidate) => {
      const row = getWorktreeOnHostFromState(state, candidate.id, candidate.hostId)
      return row && isValidResolvedWorktreeLineageEdge(child, row, lineage)
    })
    if (parent) {
      parentByChild.set(getWorktreeHostIdentity(target), parent)
    }
  }
  return (target: Target, current: State): boolean => {
    const visited = new Set<string>()
    let cursor = target
    while (!visited.has(getWorktreeHostIdentity(cursor))) {
      visited.add(getWorktreeHostIdentity(cursor))
      const parent = parentByChild.get(getWorktreeHostIdentity(cursor))
      if (!parent) {
        return true
      }
      const childRow = getWorktreeOnHostFromState(current, cursor.id, cursor.hostId)
      const parentRow = getWorktreeOnHostFromState(current, parent.id, parent.hostId)
      const lineage = childRow && getProjectedWorktreeLineage(childRow, current.worktreeLineageById)
      // An ancestor can be reparented while this branch waits for another deletion.
      if (
        !childRow ||
        !parentRow ||
        !lineage ||
        childRow.instanceId !== cursor.instanceId ||
        parentRow.instanceId !== parent.instanceId ||
        !isValidResolvedWorktreeLineageEdge(childRow, parentRow, lineage)
      ) {
        return false
      }
      cursor = parent
    }
    return false
  }
}
