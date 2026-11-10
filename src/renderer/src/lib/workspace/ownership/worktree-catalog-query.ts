import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { isIndexKey } from '@/store/keyed-record-index-keys'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import { worktreeOwnerHostIds, worktreeOwnerIdentity } from './workspace-catalog-owner-index'

export type WorktreeOwnerRecord = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
>
type Location = { bucket: string; position: number; owner: WorktreeOwnerRecord }
export type IndexedWorktreeOwnerEntry = ({ kind: 'resolved' } & Location) | { kind: 'ambiguous' }
type Bucket = { source: object; rowsById: Map<string, Location[]> }
type CatalogIndex = {
  owners: Map<string, IndexedWorktreeOwnerEntry>
  matches: Map<string, WorktreeOwnerRecord[]>
  first: Map<string, Location>
  locationsById: Map<string, Location[]>
  buckets: Map<string, Bucket>
  bucketsById: Map<string, Set<string>>
  keysById: Map<string, Set<string>>
  order: Map<string, number>
  nextOrder: number
}

function sameOwnerRows(
  a: readonly WorktreeOwnerRecord[],
  b: readonly WorktreeOwnerRecord[]
): boolean {
  return (
    a.length === b.length &&
    a.every((row, at) => {
      const next = b[at]
      return (
        row.id === next.id &&
        row.repoId === next.repoId &&
        row.hostId === next.hostId &&
        row.runtimeOwnerEnvironmentId === next.runtimeOwnerEnvironmentId
      )
    })
  )
}

function compareBuckets(index: CatalogIndex, a: string, b: string): number {
  const numericA = isIndexKey(a)
  const numericB = isIndexKey(b)
  return numericA || numericB
    ? numericA && numericB
      ? Number(a) - Number(b)
      : numericA
        ? -1
        : 1
    : index.order.get(a)! - index.order.get(b)!
}

export function createWorktreeCatalogQuery<B extends object>(
  rowsOf: (bucket: B) => readonly WorktreeOwnerRecord[],
  includeOwners: boolean
) {
  type Source = Record<string, B>
  type Cursor = { source: Source; index: CatalogIndex }
  const snapshots = new WeakMap<Source, CatalogIndex>()
  const current = new WeakMap<Source, WeakRef<Cursor>>()

  function replaceBucket(
    index: CatalogIndex,
    source: Source,
    bucketId: string,
    affected: Set<string>
  ): void {
    const old = index.buckets.get(bucketId)
    const bucket = Object.hasOwn(source, bucketId) ? source[bucketId] : undefined
    if (old?.source === bucket) {
      return
    }
    for (const id of old?.rowsById.keys() ?? []) {
      affected.add(id)
      const buckets = index.bucketsById.get(id)!
      buckets.delete(bucketId)
      if (!buckets.size) {
        index.bucketsById.delete(id)
      }
    }
    if (!bucket) {
      index.buckets.delete(bucketId)
      index.order.delete(bucketId)
      return
    }
    const rowsById = new Map<string, Location[]>()
    rowsOf(bucket).forEach((owner, position) => {
      const rows = rowsById.get(owner.id) ?? []
      rows.push({ bucket: bucketId, position, owner })
      rowsById.set(owner.id, rows)
    })
    index.buckets.set(bucketId, { source: bucket, rowsById })
    for (const id of rowsById.keys()) {
      affected.add(id)
      const buckets = index.bucketsById.get(id) ?? new Set<string>()
      buckets.add(bucketId)
      index.bucketsById.set(id, buckets)
    }
  }

  function rebuildId(index: CatalogIndex, id: string): boolean {
    const before = index.matches.get(id) ?? []
    for (const key of index.keysById.get(id) ?? []) {
      index.owners.delete(key)
      index.matches.delete(key)
    }
    index.keysById.delete(id)
    index.first.delete(id)
    index.locationsById.delete(id)
    const locations: Location[] = []
    for (const bucket of index.bucketsById.get(id) ?? []) {
      locations.push(...(index.buckets.get(bucket)?.rowsById.get(id) ?? []))
    }
    locations.sort((a, b) => compareBuckets(index, a.bucket, b.bucket) || a.position - b.position)
    const keys = new Set<string>()
    for (const at of locations) {
      const { owner } = at
      if (includeOwners) {
        for (const key of [id, ...worktreeOwnerHostIds(owner).map((host) => `${id}\0${host}`)]) {
          keys.add(key)
          const prior = index.owners.get(key)
          if (!prior) {
            index.owners.set(key, { kind: 'resolved', ...at })
          } else if (
            prior.kind === 'resolved' &&
            worktreeOwnerIdentity(prior.owner) !== worktreeOwnerIdentity(owner)
          ) {
            index.owners.set(key, { kind: 'ambiguous' })
          }
        }
      }
      const host = parseExecutionHostId(owner.hostId)?.id
      for (const key of host ? [id, `${id}\0${host}`] : [id]) {
        keys.add(key)
        const rows = index.matches.get(key) ?? []
        rows.push(owner)
        index.matches.set(key, rows)
      }
    }
    if (locations.length) {
      index.locationsById.set(id, locations)
      index.first.set(id, locations[0])
      index.keysById.set(id, keys)
    }
    return !sameOwnerRows(before, index.matches.get(id) ?? [])
  }

  function build(source: Source): CatalogIndex {
    const index: CatalogIndex = {
      owners: new Map(),
      matches: new Map(),
      first: new Map(),
      locationsById: new Map(),
      buckets: new Map(),
      bucketsById: new Map(),
      keysById: new Map(),
      order: new Map(),
      nextOrder: 0
    }
    const affected = new Set<string>()
    for (const bucket of Object.keys(source)) {
      index.order.set(bucket, index.nextOrder++)
      replaceBucket(index, source, bucket, affected)
    }
    for (const id of affected) {
      rebuildId(index, id)
    }
    return index
  }

  function live(source: Source): Cursor | undefined {
    const cursor = current.get(source)?.deref()
    return cursor?.source === source ? cursor : undefined
  }

  function read(source: Source): CatalogIndex {
    const cached = snapshots.get(source)
    if (cached) {
      return cached
    }
    const cursor = live(source)
    if (cursor) {
      return cursor.index
    }
    const index = build(source)
    snapshots.set(source, index)
    return index
  }

  function claim(source: Source): Cursor {
    const cached = snapshots.get(source)
    snapshots.delete(source)
    const cursor = { source, index: cached ?? build(source) }
    current.set(source, new WeakRef(cursor))
    return cursor
  }

  function withdraw(cursor: Cursor): void {
    if (current.get(cursor.source)?.deref() === cursor) {
      current.delete(cursor.source)
    }
  }

  return {
    read,
    createOwner() {
      let cursor: Cursor | undefined
      function accept(source: Source | undefined, previous?: Source): ReadonlySet<string> {
        if (!source) {
          if (cursor) {
            withdraw(cursor)
          }
          cursor = undefined
          return new Set()
        }
        if (!cursor) {
          if (snapshots.has(source) || live(source)) {
            cursor = claim(source)
          } else if (previous && (snapshots.has(previous) || live(previous))) {
            cursor = claim(previous)
          } else {
            return new Set()
          }
        }
        if (cursor.source === source) {
          return new Set()
        }
        const changes = readRecordChanges(source, cursor.source)
        withdraw(cursor)
        const changed = new Set<string>()
        if (changes?.kind === 'addressed') {
          for (const bucket of changes.added) {
            cursor.index.order.set(bucket, cursor.index.nextOrder++)
          }
          const affected = new Set<string>()
          for (const bucket of changes.keys) {
            replaceBucket(cursor.index, source, bucket, affected)
          }
          for (const id of affected) {
            if (rebuildId(cursor.index, id)) {
              changed.add(id)
            }
          }
        } else {
          const next = build(source)
          for (const id of new Set([...cursor.index.matches.keys(), ...next.matches.keys()])) {
            if (!sameOwnerRows(cursor.index.matches.get(id) ?? [], next.matches.get(id) ?? [])) {
              changed.add(id)
            }
          }
          cursor.index = next
        }
        cursor.source = source
        current.set(source, new WeakRef(cursor))
        return changed
      }
      return {
        accept,
        ensure(source: Source | undefined): void {
          if (!source) {
            return
          }
          if (!cursor) {
            cursor = claim(source)
          } else {
            accept(source)
          }
        }
      }
    }
  }
}
