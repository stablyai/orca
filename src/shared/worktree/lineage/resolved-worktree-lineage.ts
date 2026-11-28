import type { WorktreeLineage } from '../lineage-types'
import type { Worktree } from '../types'

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
  const connected = new Set(seedIds)
  if (connected.size === 0) {
    return connected
  }
  let childrenByParentId: Map<string, string[]> | undefined
  for (const childId in lineageById) {
    if (!Object.hasOwn(lineageById, childId)) {
      continue
    }
    const parentId = lineageById[childId].parentWorktreeId
    childrenByParentId ??= new Map()
    const children = childrenByParentId.get(parentId)
    if (children) {
      children.push(childId)
    } else {
      childrenByParentId.set(parentId, [childId])
    }
  }
  if (!childrenByParentId) {
    return connected
  }
  const pending = [...connected]
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]
    const parentId = Object.hasOwn(lineageById, id) ? lineageById[id].parentWorktreeId : undefined
    if (parentId && !connected.has(parentId)) {
      connected.add(parentId)
      pending.push(parentId)
    }
    const children = childrenByParentId.get(id)
    if (children) {
      for (const childId of children) {
        if (childId && !connected.has(childId)) {
          connected.add(childId)
          pending.push(childId)
        }
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
  if (worktrees.length === 0) {
    return []
  }
  const allWorktrees: readonly Worktree[] =
    knownPeers.length === 0 ? worktrees : [...worktrees, ...knownPeers]
  let hasAnyLineage = false
  for (const row of allWorktrees) {
    if (Object.hasOwn(lineageById, row.id)) {
      hasAnyLineage = true
      break
    }
  }
  if (!hasAnyLineage) {
    return worktrees.map((worktree) => ({
      ...worktree,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }))
  }
  const indicesById = new Map<string, number | number[]>()
  for (let index = 0; index < allWorktrees.length; index += 1) {
    const id = allWorktrees[index].id
    const existing = indicesById.get(id)
    if (existing === undefined) {
      indicesById.set(id, index)
    } else if (typeof existing === 'number') {
      indicesById.set(id, [existing, index])
    } else {
      existing.push(index)
    }
  }
  const validLineageByChildIndex = new Map<number, WorktreeLineage>()
  const parentIndexByChildIndex = new Map<number, number>()
  const childIdsByParentIndex = new Map<number, string[]>()

  for (let childIndex = 0; childIndex < allWorktrees.length; childIndex += 1) {
    const child = allWorktrees[childIndex]
    if (!Object.hasOwn(lineageById, child.id)) {
      continue
    }
    const lineage = lineageById[child.id]
    const candidates = indicesById.get(lineage.parentWorktreeId)
    if (candidates === undefined) {
      continue
    }
    let soleParentIndex = -1
    if (typeof candidates === 'number') {
      if (isValidResolvedWorktreeLineageEdge(child, allWorktrees[candidates], lineage)) {
        soleParentIndex = candidates
      }
    } else {
      // A locator can exist on several hosts. An ambiguous parent must not be selected by row order.
      let matchCount = 0
      for (const candidateIndex of candidates) {
        if (isValidResolvedWorktreeLineageEdge(child, allWorktrees[candidateIndex], lineage)) {
          soleParentIndex = candidateIndex
          matchCount += 1
          if (matchCount > 1) {
            soleParentIndex = -1
            break
          }
        }
      }
    }
    if (soleParentIndex === -1) {
      continue
    }
    validLineageByChildIndex.set(childIndex, lineage)
    parentIndexByChildIndex.set(childIndex, soleParentIndex)
  }

  if (parentIndexByChildIndex.size > 0) {
    for (const index of getCyclicLineageChildKeys(parentIndexByChildIndex)) {
      validLineageByChildIndex.delete(index)
      parentIndexByChildIndex.delete(index)
    }
    for (const [childIndex, parentIndex] of parentIndexByChildIndex) {
      const children = childIdsByParentIndex.get(parentIndex)
      if (children) {
        children.push(allWorktrees[childIndex].id)
      } else {
        childIdsByParentIndex.set(parentIndex, [allWorktrees[childIndex].id])
      }
    }
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
