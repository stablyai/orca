import { describe, expect, it } from 'vitest'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex,
  type ProcessIdentityRow
} from './process-table-index'

// A per-call reference walk with the pre-guard semantics, for parity assertions
// on well-formed tables: push children in capture order, pop last-pushed first.
function referenceWalk<Row extends ProcessIdentityRow>(
  rows: readonly Row[],
  rootPid: number
): (Row & { depth: number })[] {
  const index = buildProcessTableIndex(rows)
  const out: (Row & { depth: number })[] = []
  const stack = (index.childrenByPpid.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    out.push({ ...row, depth })
    for (const child of index.childrenByPpid.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return out
}

describe('collectDescendantsFromIndex', () => {
  it('returns descendants deepest-last for a well-formed tree, matching the plain walk', () => {
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 201, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 301, ppid: 200 },
      { pid: 400, ppid: 201 }
    ]
    const got = collectDescendantsFromIndex(buildProcessTableIndex(rows), 100)
    expect(got).toEqual(referenceWalk(rows, 100))
    expect(got.map((r) => r.pid).sort()).toEqual([200, 201, 300, 301, 400])
  })

  it('terminates on a PID-reuse cycle instead of allocating without bound', () => {
    // A non-atomic capture reused pid 3: it is both a descendant of the shell and,
    // on a later row, the parent of pid 2 whose own child is pid 3 again -> 3<->2.
    // The pre-guard walk looped here and OOMed the terminal host (stablyai/orca#16797).
    const rows = [
      { pid: 9, ppid: 1 },
      { pid: 3, ppid: 9 },
      { pid: 2, ppid: 3 },
      { pid: 3, ppid: 2 }
    ]
    const got = collectDescendantsFromIndex(buildProcessTableIndex(rows), 9)
    // Each pid is visited at most once, so the result is bounded by the row count.
    expect(got.length).toBeLessThanOrEqual(rows.length)
    expect(new Set(got.map((r) => r.pid)).size).toBe(got.length)
  })

  it('does not loop on a self-parented row (pid === ppid)', () => {
    const rows = [
      { pid: 5, ppid: 5 },
      { pid: 6, ppid: 5 }
    ]
    const got = collectDescendantsFromIndex(buildProcessTableIndex(rows), 5)
    expect(got.map((r) => r.pid)).toEqual([6])
  })

  it('does not revisit the root pid if a descendant row reuses it', () => {
    const rows = [
      { pid: 50, ppid: 1 },
      { pid: 60, ppid: 50 },
      { pid: 50, ppid: 60 } // pid 50 reused as a grandchild of itself
    ]
    const got = collectDescendantsFromIndex(buildProcessTableIndex(rows), 50)
    expect(got.length).toBeLessThanOrEqual(rows.length)
    expect(got.some((r) => r.pid === 60)).toBe(true)
  })
})
