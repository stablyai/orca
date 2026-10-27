import { parseWorkspaceKey } from './workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { Worktree } from './worktree/types'

export type WorktreeWithResolvedLineage<T extends Worktree = Worktree> = T & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
}

export type WorktreeLineageBoundary = Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>

/** Paired rows name their store through the transport; local, SSH and direct WSL share ours. */
export function lineageStoreKeyForRow(row: WorktreeLineageBoundary): string {
  return (
    row.runtimeOwnerEnvironmentId ??
    (row.hostId?.startsWith('runtime:') ? row.hostId.slice('runtime:'.length) : '')
  )
}

export function sharesWorktreeLineageBoundary(
  child: WorktreeLineageBoundary,
  parent: WorktreeLineageBoundary
): boolean {
  return lineageStoreKeyForRow(child) === lineageStoreKeyForRow(parent)
}

export const sharesResolvedWorktreeLineageBoundary = sharesWorktreeLineageBoundary

export function isValidResolvedWorktreeLineageEdge(
  child: Worktree,
  parent: Worktree,
  lineage: WorktreeLineage
): boolean {
  return (
    lineage.parentStore !== 'external' &&
    child.id !== parent.id &&
    lineage.worktreeId === child.id &&
    lineage.parentWorktreeId === parent.id &&
    (child.hostId === undefined || parent.hostId === undefined || child.hostId === parent.hostId) &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

export type LineageRow = WorktreeLineageBoundary & { id: string; instanceId?: string }
export type SavedLineageEdge = {
  parentWorktreeId: string
  worktreeInstanceId?: string | null
  parentWorktreeInstanceId?: string | null
  parentStore?: 'external'
}

/** Published edges belong to their serving store; own buckets attach only to their incarnation. */
export function getSavedWorktreeLineage(
  row: LineageRow & Pick<Worktree, 'savedLineage' | 'lineage'>,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  metadata?: Readonly<Record<string, WorktreeMeta>>
): WorktreeLineage | null | undefined {
  const saved = row.savedLineage
  if (saved !== undefined || lineageStoreKeyForRow(row)) {
    return saved !== undefined ? saved : row.lineage
  }
  const ownerHostId = metadata?.[row.id]?.hostId
  if (ownerHostId && ownerHostId !== row.hostId) {
    return null
  }
  return getSavedWorktreeLineageFromFields(
    row.id,
    row.hostId,
    row.runtimeOwnerEnvironmentId,
    row.lineage,
    lineageById[row.id],
    ownerHostId
  )
}

export function getSavedWorktreeLineageFromFields(
  id: string,
  hostId: Worktree['hostId'],
  runtimeOwnerEnvironmentId: Worktree['runtimeOwnerEnvironmentId'],
  lineage: Worktree['lineage'],
  ownEdge: WorktreeLineage | undefined,
  ownerHostId?: WorktreeMeta['hostId']
): WorktreeLineage | null | undefined {
  if (
    runtimeOwnerEnvironmentId ??
    (hostId?.startsWith('runtime:') ? hostId.slice('runtime:'.length) : '')
  ) {
    return lineage
  }
  if (ownerHostId && ownerHostId !== hostId) {
    return null
  }
  return ownEdge?.worktreeId === id ? ownEdge : lineage
}

export function isSameSavedWorktreeParent(
  edge: SavedLineageEdge | null | undefined,
  child: LineageRow,
  parent: { worktreeId: string; instanceId?: string; external?: boolean }
): boolean {
  return (
    edge?.worktreeInstanceId === child.instanceId &&
    edge?.parentWorktreeId === parent.worktreeId &&
    edge?.parentWorktreeInstanceId === parent.instanceId &&
    (edge?.parentStore === 'external') === (parent.external === true)
  )
}

type Candidates<T> = { count: number; first: T; indexSum: number }
function addCandidate<T>(
  map: Map<string, Candidates<T>>,
  key: string,
  row: T,
  index: number
): void {
  const prior = map.get(key)
  if (prior) {
    prior.count += 1
    prior.indexSum += index
  } else {
    map.set(key, { count: 1, first: row, indexSum: index })
  }
}

/** Each projection indexes once; even copied identities across many stores resolve in O(rows). */
export function resolveWorktreeLineageParents<T extends LineageRow>(
  rows: readonly T[],
  lineageOf: (row: T) => SavedLineageEdge | null | undefined,
  cyclicChildren?: Set<T>,
  policy: 'store' | 'saved-walk' = 'store'
): Map<T, T> {
  const byStore = new Map<
    string,
    {
      locator: Map<string, Candidates<T>>
      instance: Map<string, Candidates<T>>
      exact: Map<string, Candidates<T>>
    }
  >()
  const aggregate = new Map<string, Candidates<T>>()
  const exactKey = (id: string, instance: string): string => JSON.stringify([id, instance])
  for (const [index, row] of rows.entries()) {
    const key = lineageStoreKeyForRow(row)
    let store = byStore.get(key)
    if (!store) {
      store = { locator: new Map(), instance: new Map(), exact: new Map() }
      byStore.set(key, store)
    }
    addCandidate(store.locator, exactKey(row.id, row.hostId ?? 'local'), row, index)
    if (row.instanceId) {
      addCandidate(store.instance, row.instanceId, row, index)
      addCandidate(store.exact, exactKey(row.id, row.instanceId), row, index)
      addCandidate(aggregate, row.instanceId, row, index)
    }
  }
  const parents = new Map<T, T>()
  for (const child of rows) {
    const edge = lineageOf(child)
    if (!edge || (edge.worktreeInstanceId && edge.worktreeInstanceId !== child.instanceId)) {
      continue
    }
    const key = lineageStoreKeyForRow(child)
    const store = byStore.get(key)
    const instance = edge.parentWorktreeInstanceId
    let parent: T | undefined
    if (instance) {
      const exact = store?.exact.get(exactKey(edge.parentWorktreeId, instance))
      const local = store?.instance.get(instance)
      if (edge.parentStore === 'external') {
        const all = aggregate.get(instance)
        if (all && all.count - (local?.count ?? 0) === 1) {
          parent = rows[all.indexSum - (local?.indexSum ?? 0)]
        }
      } else if (exact?.count === 1) {
        parent = exact.first
      } else if (local?.count === 1) {
        parent = local.first
      }
    } else if (!edge.parentStore) {
      const legacy = store?.locator.get(exactKey(edge.parentWorktreeId, child.hostId ?? 'local'))
      if (legacy?.count === 1) {
        parent = legacy.first
      }
    }
    if (parent && (policy === 'saved-walk' || parent !== child)) {
      parents.set(child, parent)
    }
  }
  if (policy === 'saved-walk') {
    return parents
  }
  for (const child of getCyclicLineageChildKeys(parents)) {
    cyclicChildren?.add(child)
    parents.delete(child)
  }
  return parents
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
  knownPeers: readonly Worktree[] = [],
  metadata?: Readonly<Record<string, WorktreeMeta>>
): WorktreeWithResolvedLineage<T>[] {
  const allWorktrees = [
    ...new Map(
      [...knownPeers, ...worktrees].map((row) => [
        JSON.stringify([row.hostId, row.runtimeOwnerEnvironmentId, row.id]),
        row
      ])
    ).values()
  ]
  const edgeOf = (row: Worktree) => getSavedWorktreeLineage(row, lineageById, metadata)
  const parents = resolveWorktreeLineageParents(allWorktrees, edgeOf)
  const children = new Map<Worktree, string[]>()
  for (const [child, parent] of parents) {
    const ids = children.get(parent) ?? []
    ids.push(child.id)
    children.set(parent, ids)
  }
  return worktrees.map((worktree) => ({
    ...worktree,
    savedLineage: edgeOf(worktree) ?? null,
    parentWorktreeId: parents.get(worktree)?.id ?? null,
    childWorktreeIds: children.get(worktree) ?? [],
    lineage: parents.has(worktree) ? (edgeOf(worktree) ?? null) : null
  }))
}

/** Workspace keys already identify standalone folders; legacy links keep their locator fallback. */
export function worktreeLineageFromWorkspaceLineage(edge: WorkspaceLineage): WorktreeLineage {
  const child = parseWorkspaceKey(edge.childWorkspaceKey)
  const parent = parseWorkspaceKey(edge.parentWorkspaceKey)
  return {
    ...edge,
    worktreeId: child?.type === 'worktree' ? child.worktreeId : edge.childWorkspaceKey,
    worktreeInstanceId: edge.childInstanceId ?? '',
    parentWorktreeId: parent?.type === 'worktree' ? parent.worktreeId : edge.parentWorkspaceKey,
    parentWorktreeInstanceId: edge.parentInstanceId ?? ''
  }
}

export function mergeWorkspaceLineageRecords(
  worktreeLineage: Readonly<Record<string, WorktreeLineage>>,
  workspaceLineage: Readonly<Record<string, WorkspaceLineage>>
): Record<string, WorktreeLineage> {
  return {
    ...Object.fromEntries(
      Object.values(workspaceLineage).map((edge) => {
        const lineage = worktreeLineageFromWorkspaceLineage(edge)
        return [lineage.worktreeId, lineage]
      })
    ),
    ...worktreeLineage
  }
}
