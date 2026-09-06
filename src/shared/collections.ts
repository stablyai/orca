import type { Collection } from './collection-types'

function createCollectionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `collection-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

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
    id: createCollectionId(),
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

/** Canonical membership form: a deduped id array, or undefined when empty.
 *  [] is never persisted so pre-collection records stay byte-identical. */
export function normalizeCollectionIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids.length > 0 ? ids : undefined
}

export function addCollectionId(
  ids: readonly string[] | undefined,
  collectionId: string
): string[] {
  if (!ids || ids.length === 0) {
    return [collectionId]
  }
  return ids.includes(collectionId) ? [...ids] : [...ids, collectionId]
}

/** Membership after an add/move gesture. Exclusive membership (feature
 *  worktrees) replaces every existing membership — a worktree lives in one
 *  workstream. Non-exclusive (main worktrees) appends: the primary checkout is
 *  shared infrastructure and may sit in every collection. */
export function assignCollectionMembership(
  ids: readonly string[] | undefined,
  collectionId: string,
  options: { exclusive: boolean }
): string[] {
  return options.exclusive ? [collectionId] : addCollectionId(ids, collectionId)
}

/** Data-layer guard for amended D1: a feature worktree keeps only its most
 *  recent membership (last id wins — every gesture appends the new home last),
 *  while main worktrees may keep many. [] passes through untouched so the
 *  "remove from every collection" blanking contract survives. */
export function clampExclusiveCollectionMembership(
  ids: readonly string[],
  isMainWorktree: boolean
): string[] {
  if (isMainWorktree || ids.length <= 1) {
    return [...ids]
  }
  return [ids.at(-1)!]
}

export function removeCollectionId(
  ids: readonly string[] | undefined,
  collectionId: string
): string[] | undefined {
  if (!ids) {
    return undefined
  }
  const next = ids.filter((id) => id !== collectionId)
  return next.length > 0 ? next : undefined
}

export function isInCollection(ids: readonly string[] | undefined, collectionId: string): boolean {
  return ids?.includes(collectionId) ?? false
}

export function pruneMissingCollectionIds(
  ids: readonly string[] | undefined,
  existingCollectionIds: ReadonlySet<string>
): string[] | undefined {
  if (!ids) {
    return undefined
  }
  const next = ids.filter((id) => existingCollectionIds.has(id))
  return next.length > 0 ? next : undefined
}
