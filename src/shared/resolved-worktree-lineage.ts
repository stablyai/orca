import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'

export type WorktreeWithResolvedLineage<T extends Worktree = Worktree> = T & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
}

/** The execution host is the only lineage boundary. */
export type WorktreeLineageBoundary = Pick<Worktree, 'hostId'>

export function sharesWorktreeLineageBoundary(
  child: WorktreeLineageBoundary,
  parent: WorktreeLineageBoundary
): boolean {
  return child.hostId === undefined || parent.hostId === undefined || child.hostId === parent.hostId
}

export function sharesResolvedWorktreeLineageBoundary(child: Worktree, parent: Worktree): boolean {
  return sharesWorktreeLineageBoundary(child, parent)
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

/** The children on a cycle of a child-to-parent map, whatever the keys are. */
export function getCyclicLineageChildKeys<Key>(parentByChild: ReadonlyMap<Key, Key>): Set<Key> {
  const processed = new Set<Key>()
  const cyclic = new Set<Key>()

  for (const childId of parentByChild.keys()) {
    if (processed.has(childId)) {
      continue
    }
    const path: Key[] = []
    const pathIndexById = new Map<Key, number>()
    let currentId: Key | undefined = childId
    while (currentId !== undefined && parentByChild.has(currentId) && !processed.has(currentId)) {
      const cycleStart = pathIndexById.get(currentId)
      if (cycleStart !== undefined) {
        for (let index = cycleStart; index < path.length; index += 1) {
          cyclic.add(path[index])
        }
        break
      }
      pathIndexById.set(currentId, path.length)
      path.push(currentId)
      currentId = parentByChild.get(currentId)
    }
    for (const id of path) {
      processed.add(id)
    }
  }

  return cyclic
}

export function getCyclicWorktreeLineageChildIds(
  lineageByChildId: ReadonlyMap<string, WorktreeLineage>
): Set<string> {
  return getCyclicLineageChildKeys(
    new Map([...lineageByChildId].map(([childId, lineage]) => [childId, lineage.parentWorktreeId]))
  )
}

export function getConnectedWorktreeLineageIds(
  seedIds: readonly string[],
  lineageById: Readonly<Record<string, WorktreeLineage>>
): Set<string> {
  const childrenByParentId = new Map<string, string[]>()
  for (const [childId, lineage] of Object.entries(lineageById)) {
    const children = childrenByParentId.get(lineage.parentWorktreeId) ?? []
    children.push(childId)
    childrenByParentId.set(lineage.parentWorktreeId, children)
  }
  const connected = new Set(seedIds)
  const pending = [...connected]
  for (const id of pending) {
    for (const adjacent of [
      lineageById[id]?.parentWorktreeId,
      ...(childrenByParentId.get(id) ?? [])
    ]) {
      if (adjacent && !connected.has(adjacent)) {
        connected.add(adjacent)
        pending.push(adjacent)
      }
    }
  }
  return connected
}

export function projectResolvedWorktreeLineage<T extends Worktree>(
  worktrees: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  knownPeers: readonly Worktree[] = []
): WorktreeWithResolvedLineage<T>[] {
  const allWorktrees: readonly Worktree[] = [...worktrees, ...knownPeers]
  const indicesById = new Map<string, number[]>()
  allWorktrees.forEach((worktree, index) => {
    const indices = indicesById.get(worktree.id) ?? []
    indices.push(index)
    indicesById.set(worktree.id, indices)
  })
  const validLineageByChildIndex = new Map<number, WorktreeLineage>()
  const parentIndexByChildIndex = new Map<number, number>()
  const childIdsByParentIndex = new Map<number, string[]>()

  allWorktrees.forEach((child, childIndex) => {
    const lineage = lineageById[child.id]
    if (!lineage) {
      return
    }
    const parentIndices = (indicesById.get(lineage.parentWorktreeId) ?? []).filter((index) =>
      isValidResolvedWorktreeLineageEdge(child, allWorktrees[index], lineage)
    )
    // A locator can exist on several hosts. An ambiguous parent must not be selected by row order.
    if (parentIndices.length !== 1) {
      return
    }
    validLineageByChildIndex.set(childIndex, lineage)
    parentIndexByChildIndex.set(childIndex, parentIndices[0])
  })

  for (const index of getCyclicLineageChildKeys(parentIndexByChildIndex)) {
    validLineageByChildIndex.delete(index)
    parentIndexByChildIndex.delete(index)
  }

  for (const [childIndex, parentIndex] of parentIndexByChildIndex) {
    const children = childIdsByParentIndex.get(parentIndex) ?? []
    children.push(allWorktrees[childIndex].id)
    childIdsByParentIndex.set(parentIndex, children)
  }

  return worktrees.map((worktree, index) => {
    const lineage = validLineageByChildIndex.get(index) ?? null
    return {
      ...worktree,
      parentWorktreeId: lineage?.parentWorktreeId ?? null,
      childWorktreeIds: childIdsByParentIndex.get(index) ?? [],
      lineage
    }
  })
}
