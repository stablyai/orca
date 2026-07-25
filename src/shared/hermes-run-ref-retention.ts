export const HERMES_RUN_REF_MAX_ENTRIES = 10_000
export const HERMES_RUN_REF_ID_MAX_BYTES = 4 * 1024

export const HERMES_SESSION_RUN_REFS_SELECT_SQL = `SELECT
  CASE WHEN length(CAST(id AS BLOB)) <= ${HERMES_RUN_REF_ID_MAX_BYTES} THEN id ELSE NULL END AS id,
  CASE WHEN typeof(started_at) IN ('integer', 'real') THEN started_at ELSE NULL END AS started_at
FROM sessions
WHERE id LIKE ? ESCAPE '\\'
ORDER BY started_at DESC
LIMIT ${HERMES_RUN_REF_MAX_ENTRIES + 1}`

export type HermesSortableRunRef = {
  id: string
  run_at: string | null
}

export type BoundedHermesRunRefs<T> = {
  refs: T[]
  saturated: boolean
}

export class HermesRunRefRetainer<T extends HermesSortableRunRef> {
  private readonly retained: T[] = []
  private readonly pending: T[] = []
  private readonly maxEntries: number
  private seen = 0

  constructor(maxEntries = HERMES_RUN_REF_MAX_ENTRIES) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.min(HERMES_RUN_REF_MAX_ENTRIES, Math.floor(maxEntries)))
      : HERMES_RUN_REF_MAX_ENTRIES
  }

  add(ref: T): void {
    this.seen += 1
    if (this.maxEntries === 0) {
      return
    }
    this.pending.push(ref)
    if (this.pending.length >= this.maxEntries) {
      this.flush()
    }
  }

  finish(): BoundedHermesRunRefs<T> {
    this.flush()
    return {
      refs: this.retained.slice(),
      saturated: this.seen > this.maxEntries
    }
  }

  private flush(): void {
    if (this.pending.length === 0) {
      return
    }
    for (const ref of this.pending) {
      this.retained.push(ref)
    }
    this.pending.length = 0
    this.retained.sort(compareHermesRunRefsNewestFirst)
    if (this.retained.length > this.maxEntries) {
      this.retained.length = this.maxEntries
    }
  }
}

export function compareHermesRunRefsNewestFirst(
  left: HermesSortableRunRef,
  right: HermesSortableRunRef
): number {
  const leftTime = left.run_at ? Date.parse(left.run_at) : Number.NaN
  const rightTime = right.run_at ? Date.parse(right.run_at) : Number.NaN
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime
  }
  return right.id.localeCompare(left.id)
}
