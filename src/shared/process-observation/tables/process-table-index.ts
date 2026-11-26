import type { ProcessTableRow } from './process-table-snapshot'

/** Share generic process-table indexes between POSIX and Windows capture shapes. */

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

/** Build only byPid/children indexes in one pass; unused group maps add allocations while foreground membership
 * comes directly from row pgid/root tpgid. Generic rows share this work across POSIX and Windows. */
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

/** Depth-first descendants copied with depth so callers cannot mutate indexed rows; retain capture child order and LIFO traversal. */
export function collectDescendantsFromIndex<Row extends ProcessIdentityRow>(
  index: ProcessTableIndexOf<Row>,
  rootPid: number,
  /** Excludes a row and everything below it. */
  prune?: (row: Row) => boolean
): (Row & { depth: number })[] {
  const descendants: (Row & { depth: number })[] = []
  // PID reuse can make a process snapshot cyclic; queue each PID at most once.
  const visited = new Set<number>([rootPid])
  const stack: { row: Row; depth: number }[] = []
  const pushUnvisited = (row: Row, depth: number): void => {
    if (visited.has(row.pid) || prune?.(row)) {
      return
    }
    visited.add(row.pid)
    stack.push({ row, depth })
  }
  for (const child of index.childrenByPpid.get(rootPid) ?? []) {
    pushUnvisited(child, 1)
  }
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of index.childrenByPpid.get(row.pid) ?? []) {
      pushUnvisited(child, depth + 1)
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

/** Weakly memoize per-snapshot identity so panes sharing a TTL capture build two indexes only once. Never share stats:
 * that would expose another caller’s counter bag and count cache hits as builds; measured callers build directly. */
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
