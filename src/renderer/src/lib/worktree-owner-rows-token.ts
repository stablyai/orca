import type { WorktreeOperationOwnerRecord } from './worktree-operation-route'

type WorktreeOwnerRows = Record<string, readonly WorktreeOperationOwnerRecord[]>

const ownerRowTokens = new WeakMap<WorktreeOwnerRows, object>()
// Weak so a removed catalog isn't pinned when nothing tokenizes a newer map.
let lastOwnerRows: { rows: WeakRef<WorktreeOwnerRows>; token: object } | null = null

function sameOwner(a: WorktreeOperationOwnerRecord, b: WorktreeOperationOwnerRecord): boolean {
  // Every owner field, so a new one cannot be silently left out of the comparison.
  const fields: { [K in keyof Required<WorktreeOperationOwnerRecord>]: boolean } = {
    id: a.id === b.id,
    repoId: a.repoId === b.repoId,
    hostId: (a.hostId ?? null) === (b.hostId ?? null),
    runtimeOwnerEnvironmentId:
      (a.runtimeOwnerEnvironmentId ?? null) === (b.runtimeOwnerEnvironmentId ?? null)
  }
  return fields.id && fields.repoId && fields.hostId && fields.runtimeOwnerEnvironmentId
}

/** Identity-first walk: a patch usually reuses every bucket and row but one, so this stays allocation-free on the hot path. */
function sameOwnerRows(a: WorktreeOwnerRows, b: WorktreeOwnerRows): boolean {
  const aBuckets = Object.keys(a)
  const bBuckets = Object.keys(b)
  if (aBuckets.length !== bBuckets.length) {
    return false
  }
  for (let bucketIndex = 0; bucketIndex < aBuckets.length; bucketIndex++) {
    const bucket = aBuckets[bucketIndex]
    if (bucket !== bBuckets[bucketIndex]) {
      return false
    }
    const aRows = a[bucket]
    const bRows = b[bucket]
    if (aRows === bRows) {
      continue
    }
    if (aRows.length !== bRows.length) {
      return false
    }
    for (let rowIndex = 0; rowIndex < aRows.length; rowIndex++) {
      const aRow = aRows[rowIndex]
      const bRow = bRows[rowIndex]
      if (aRow !== bRow && !sameOwner(aRow, bRow)) {
        return false
      }
    }
  }
  return true
}

/** Equal tokens mean equal row ownership; rank/unread/activity patches keep the token, so owner consumers can skip them. */
export function worktreeOwnerRowsTokenOf(worktreesByRepo: WorktreeOwnerRows | undefined): unknown {
  if (!worktreesByRepo) {
    return worktreesByRepo
  }
  let token = ownerRowTokens.get(worktreesByRepo)
  if (!token) {
    const lastRows = lastOwnerRows?.rows.deref()
    token =
      lastOwnerRows && lastRows && sameOwnerRows(lastRows, worktreesByRepo)
        ? lastOwnerRows.token
        : {}
    lastOwnerRows = { rows: new WeakRef(worktreesByRepo), token }
    ownerRowTokens.set(worktreesByRepo, token)
  }
  return token
}
