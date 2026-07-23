import type { Worktree, WorktreeLineage } from './types'

export type WorktreeWithResolvedLineage<T extends Worktree = Worktree> = T & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
}

export function sharesResolvedWorktreeLineageBoundary(child: Worktree, parent: Worktree): boolean {
  return (
    child.repoId === parent.repoId &&
    (child.hostId === undefined || parent.hostId === undefined || child.hostId === parent.hostId) &&
    (child.projectId === undefined ||
      parent.projectId === undefined ||
      child.projectId === parent.projectId)
  )
}

export function isValidResolvedWorktreeLineageEdge(
  child: Worktree,
  parent: Worktree,
  lineage: WorktreeLineage
): boolean {
  return (
    child.id !== parent.id &&
    lineage.worktreeId === child.id &&
    lineage.parentWorktreeId === parent.id &&
    sharesResolvedWorktreeLineageBoundary(child, parent) &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

export function getCyclicWorktreeLineageChildIds(
  lineageByChildId: ReadonlyMap<string, WorktreeLineage>
): Set<string> {
  const processed = new Set<string>()
  const cyclic = new Set<string>()

  for (const childId of lineageByChildId.keys()) {
    if (processed.has(childId)) {
      continue
    }
    const path: string[] = []
    const pathIndexById = new Map<string, number>()
    let currentId: string | undefined = childId
    while (currentId && lineageByChildId.has(currentId) && !processed.has(currentId)) {
      const cycleStart = pathIndexById.get(currentId)
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < path.length; index += 1) {
          cyclic.add(path[index])
        }
        break
      }
      pathIndexById.set(currentId, path.length)
      path.push(currentId)
      currentId = lineageByChildId.get(currentId)?.parentWorktreeId
    }
    for (const id of path) {
      processed.add(id)
    }
  }

  return cyclic
}

export function projectResolvedWorktreeLineage<T extends Worktree>(
  worktrees: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeWithResolvedLineage<T>[] {
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  const childIdsByParentId = new Map<string, string[]>()

  for (const child of worktrees) {
    const childId = child.id
    const lineage = lineageById[childId]
    if (!lineage) {
      continue
    }
    const parent = worktreeById.get(lineage.parentWorktreeId)
    if (!parent || !isValidResolvedWorktreeLineageEdge(child, parent, lineage)) {
      continue
    }
    validLineageByChildId.set(childId, lineage)
  }

  const cyclicChildIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  for (const childId of cyclicChildIds) {
    validLineageByChildId.delete(childId)
  }

  for (const [childId, lineage] of validLineageByChildId) {
    const children = childIdsByParentId.get(lineage.parentWorktreeId) ?? []
    children.push(childId)
    childIdsByParentId.set(lineage.parentWorktreeId, children)
  }

  return worktrees.map((worktree) => {
    const lineage = validLineageByChildId.get(worktree.id) ?? null
    return {
      ...worktree,
      parentWorktreeId: lineage?.parentWorktreeId ?? null,
      childWorktreeIds: childIdsByParentId.get(worktree.id) ?? [],
      lineage
    }
  })
}
