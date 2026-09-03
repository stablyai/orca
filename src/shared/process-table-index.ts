import type { ProcessTableRow } from './process-table-snapshot'

/**
 * Correlation indexes over a process-table capture, generic over the row shape so the POSIX
 * `ps` snapshot and the Windows process table share one pass instead of parallel ones.
 */

export type ProcessTableIndexStats = {
  captures?: number
  indexBuilds: number
  rowVisits: number
  indexLookups: number
}

/** The parent/child fields every process-table row shape shares. */
export type ProcessIdentityRow = { pid: number; ppid: number }

export type ProcessTableIndexOf<Row extends ProcessIdentityRow> = {
  rows: readonly Row[]
  byPid: ReadonlyMap<number, Row>
  childrenByPpid: ReadonlyMap<number, readonly Row[]>
  stats?: ProcessTableIndexStats
}

/** POSIX process-table index shape used by foreground-process resolvers. */
export type ProcessTableIndex = ProcessTableIndexOf<ProcessTableRow>

/**
 * Build the correlation indexes in one linear pass over a capture. Only the
 * indexes a resolver actually reads are materialized: group indexes would cost
 * two more maps plus a per-row array allocation on every capture, and foreground
 * membership is derived from each row's own `pgid` against the root's `tpgid`.
 *
 * Generic over the row shape so the Windows snapshot (`pid`/`ppid`/`name`/
 * `command`) shares this pass rather than carrying a parallel one.
 */
export function buildProcessTableIndex<Row extends ProcessIdentityRow>(
  rows: readonly Row[],
  stats?: ProcessTableIndexStats
): ProcessTableIndexOf<Row> {
  if (stats) {
    stats.indexBuilds += 1
  }
  const byPid = new Map<number, Row>()
  const childrenByPpid = new Map<number, Row[]>()
  for (const row of rows) {
    if (stats) {
      stats.rowVisits += 1
    }
    // Preserve rows.find() semantics if a malformed table repeats a pid
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
    const children = childrenByPpid.get(row.ppid) ?? []
    children.push(row)
    childrenByPpid.set(row.ppid, children)
  }
  return { rows, byPid, childrenByPpid, stats }
}

/**
 * Depth-first descendants of `rootPid`, deepest-last, off a prebuilt index.
 *
 * Each row is copied with its depth, so callers may not mutate the index's rows
 * through the result. Ordering matches a per-call `childrenByPpid` walk exactly:
 * children keep capture order and the stack pops last-pushed first.
 */
export function collectDescendantsFromIndex<Row extends ProcessIdentityRow>(
  index: ProcessTableIndexOf<Row>,
  rootPid: number
): (Row & { depth: number })[] {
  const descendants: (Row & { depth: number })[] = []
  const stack = (index.childrenByPpid.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of index.childrenByPpid.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

export function lookupProcessTableIndex<Row extends ProcessIdentityRow, T>(
  index: ProcessTableIndexOf<Row>,
  lookup: (index: ProcessTableIndexOf<Row>) => T,
  stats = index.stats
): T {
  if (stats) {
    stats.indexLookups += 1
  }
  return lookup(index)
}

// Keyed by array identity, which also pins the row shape the entry was built
// for, so the one cast below cannot hand a caller another row type's index.
const processTableIndexes = new WeakMap<readonly ProcessIdentityRow[], unknown>()

/**
 * Memoize one index per snapshot identity, so the panes that share a TTL-cached
 * capture walk its rows once instead of once each. Keyed weakly by the rows
 * array, so an index dies with the snapshot that produced it. The shared build
 * materializes only `byPid` and `childrenByPpid`, so a one-pane relay pays for
 * two maps per capture rather than four indexes no resolver queries.
 *
 * Deliberately stats-free: `buildProcessTableIndex` mutates the caller's counter
 * bag and stores it on the index, so a shared index would hand one caller's bag
 * to an unrelated later caller and let a cache hit satisfy an `indexBuilds`
 * measurement without building anything. Measured callers keep calling
 * `buildProcessTableIndex(rows, stats)` directly.
 */
export function getProcessTableIndex<Row extends ProcessIdentityRow>(
  rows: readonly Row[]
): ProcessTableIndexOf<Row> {
  const cached = processTableIndexes.get(rows) as ProcessTableIndexOf<Row> | undefined
  if (cached) {
    return cached
  }
  const index = buildProcessTableIndex(rows)
  processTableIndexes.set(rows, index)
  return index
}
