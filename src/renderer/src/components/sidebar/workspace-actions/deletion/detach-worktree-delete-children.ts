import type { AppState } from '@/store/types'
import { forEachWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import { isPathInsideOrEqual } from '../../../../../../shared/cross-platform-path'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'

export function canPreserveWorkspaceDeleteChildren(
  parent: Worktree,
  descendants: readonly Worktree[],
  isFolderWorkspace: boolean
): boolean {
  return (
    isFolderWorkspace ||
    descendants.every(
      (child) =>
        (child.hostId !== undefined &&
          parent.hostId !== undefined &&
          child.hostId !== parent.hostId) ||
        !isPathInsideOrEqual(parent.path, child.path)
    )
  )
}

export async function detachWorktreeDeleteChildren(
  children: readonly Worktree[],
  updateWorktreeLineage: AppState['updateWorktreeLineage'],
  resolveCurrentChild: (child: Worktree) => Worktree | null,
  assertDetached: () => void
): Promise<void> {
  let failure: { reason: unknown } | undefined
  await forEachWithConcurrency(children, 4, async (child) => {
    if (failure) {
      return
    }
    try {
      const current = resolveCurrentChild(child)
      if (!current) {
        return
      }
      await updateWorktreeLineage(current.id, {
        noParent: true,
        ...(current.hostId ? { executionHostId: current.hostId } : {})
      })
    } catch (reason) {
      failure ??= { reason }
    }
  })
  if (failure) {
    throw failure.reason
  }
  assertDetached()
}

export function workspaceDeleteTargetsMatch(
  expected: readonly Worktree[],
  current: readonly Worktree[]
): boolean {
  const expectedInstances = new Map(
    expected.map((target) => [getWorktreeHostIdentity(target), target.instanceId])
  )
  return current.every(
    (target) =>
      expectedInstances.has(getWorktreeHostIdentity(target)) &&
      expectedInstances.get(getWorktreeHostIdentity(target)) === target.instanceId
  )
}

export function captureWorkspaceDeleteRowLookup(
  initialRows: AppState['worktreesByRepo'],
  targets: readonly Worktree[]
) {
  const expected = new Set(targets.map(getWorktreeHostIdentity))
  const positions = new Map<string, { repoId: string; index: number }>()
  for (const [repoId, rows] of Object.entries(initialRows)) {
    rows.forEach((row, index) => {
      const identity = getWorktreeHostIdentity(row)
      if (expected.has(identity)) {
        positions.set(identity, { repoId, index })
      }
    })
  }
  return (currentRows: AppState['worktreesByRepo'], target: Worktree): Worktree | undefined => {
    const identity = getWorktreeHostIdentity(target)
    const position = positions.get(identity)
    const current = position ? currentRows[position.repoId]?.[position.index] : undefined
    return current &&
      getWorktreeHostIdentity(current) === identity &&
      current.instanceId === target.instanceId
      ? current
      : undefined
  }
}
