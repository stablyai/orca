import type { Collection } from './collection-types'
import { createNonSecureContextUuid } from './non-secure-context-uuid'

export function normalizeCollectionName(name: string, fallback = 'Untitled collection'): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export function createCollection(input: {
  name: string
  order: number
  color?: string | null
  now?: number
}): Collection {
  const now = input.now ?? Date.now()
  return {
    id: createNonSecureContextUuid(),
    name: normalizeCollectionName(input.name),
    color: input.color ?? null,
    isCollapsed: false,
    order: input.order,
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeCollections(value: unknown): Collection[] {
  if (!Array.isArray(value)) {
    return []
  }
  const collections: Collection[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<Collection>
    if (typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) {
      continue
    }
    seen.add(raw.id)
    const now = Date.now()
    collections.push({
      id: raw.id,
      name: normalizeCollectionName(typeof raw.name === 'string' ? raw.name : ''),
      color: typeof raw.color === 'string' ? raw.color : null,
      isCollapsed: raw.isCollapsed === true,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
      createdAt:
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt:
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
    })
  }
  return sortCollectionsByOrder(collections)
}

export function sortCollectionsByOrder(collections: readonly Collection[]): Collection[] {
  return [...collections].sort(
    (left, right) => left.order - right.order || left.name.localeCompare(right.name)
  )
}

export function getNextCollectionOrder(collections: readonly Collection[]): number {
  let max = -1
  for (const collection of collections) {
    if (Number.isFinite(collection.order)) {
      max = Math.max(max, collection.order)
    }
  }
  return max + 1
}

/** Membership after an add/move gesture: exclusive (feature worktrees) moves; non-exclusive
 *  (main worktrees, shared infrastructure) appends. */
export function assignCollectionMembership(
  ids: readonly string[] | undefined,
  collectionId: string,
  options: { exclusive: boolean }
): string[] {
  if (options.exclusive || !ids) {
    return [collectionId]
  }
  return ids.includes(collectionId) ? [...ids] : [...ids, collectionId]
}

/** Data-layer guard: a feature worktree keeps only its last membership, main worktrees keep many;
 *  [] passes through so "remove from every collection" still blanks. */
export function clampExclusiveCollectionMembership(
  ids: readonly string[],
  isMainWorktree: boolean
): string[] {
  if (isMainWorktree || ids.length <= 1) {
    return [...ids]
  }
  return [ids.at(-1)!]
}
