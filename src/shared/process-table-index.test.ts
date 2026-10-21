import { describe, expect, it, vi } from 'vitest'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex,
  type ProcessIdentityRow
} from './process-table-index'
import { parseStrictProcessTableRows } from './process-table-snapshot'

function boundedWalk<Row extends ProcessIdentityRow>(rows: readonly Row[], rootPid: number) {
  const index = buildProcessTableIndex(rows)
  const get = index.childrenByPpid.get.bind(index.childrenByPpid)
  let lookups = 0
  // A missing cycle guard must fail the test before it can hang or exhaust memory.
  const spy = vi.spyOn(index.childrenByPpid, 'get').mockImplementation((pid) => {
    if (++lookups > rows.length + 1) {
      throw new Error('Descendant walk exceeded the row budget')
    }
    return get(pid)
  })
  try {
    const result = collectDescendantsFromIndex(index, rootPid)
    expect(result.some((row) => row.pid === rootPid)).toBe(false)
    expect(new Set(result.map((row) => row.pid)).size).toBe(result.length)
    return result
  } finally {
    spy.mockRestore()
  }
}

describe('collectDescendantsFromIndex', () => {
  it('preserves capture-order stack traversal, depth, row fields and input ownership', () => {
    const rows = Object.freeze([
      Object.freeze({ pid: 100, ppid: 1, command: 'shell' }),
      Object.freeze({ pid: 200, ppid: 100, command: 'left' }),
      Object.freeze({ pid: 201, ppid: 100, command: 'right' }),
      Object.freeze({ pid: 300, ppid: 200, command: 'left-first' }),
      Object.freeze({ pid: 301, ppid: 200, command: 'left-last' }),
      Object.freeze({ pid: 400, ppid: 201, command: 'right-child' })
    ])
    const result = boundedWalk(rows, 100)
    expect(result).toEqual([
      { ...rows[2], depth: 1 },
      { ...rows[5], depth: 2 },
      { ...rows[1], depth: 1 },
      { ...rows[4], depth: 2 },
      { ...rows[3], depth: 2 }
    ])
    expect(result[0]).not.toBe(rows[2])
    expect(Object.isFrozen(result[0])).toBe(false)
  })

  it('excludes a self-parented root', () => {
    expect(
      boundedWalk(
        [
          { pid: 5, ppid: 5 },
          { pid: 6, ppid: 5 }
        ],
        5
      )
    ).toEqual([{ pid: 6, ppid: 5, depth: 1 }])
  })

  it('excludes the root from a two-node cycle with unique PIDs', () => {
    expect(
      boundedWalk(
        [
          { pid: 5, ppid: 6 },
          { pid: 6, ppid: 5 }
        ],
        5
      )
    ).toEqual([{ pid: 6, ppid: 5, depth: 1 }])
  })

  it('terminates on a reachable two-node cycle with duplicate rows', () => {
    const rows = [
      { pid: 9, ppid: 1 },
      { pid: 3, ppid: 9 },
      { pid: 2, ppid: 3 },
      { pid: 3, ppid: 2 }
    ]
    expect(boundedWalk(rows, 9)).toEqual([
      { pid: 3, ppid: 9, depth: 1 },
      { pid: 2, ppid: 3, depth: 2 }
    ])
  })

  it('terminates on a reachable self-cycle', () => {
    expect(
      boundedWalk(
        [
          { pid: 2, ppid: 1 },
          { pid: 2, ppid: 2 }
        ],
        1
      )
    ).toEqual([{ pid: 2, ppid: 1, depth: 1 }])
  })

  it('never returns a duplicate row that reuses the root PID', () => {
    const rows = [
      { pid: 50, ppid: 1 },
      { pid: 60, ppid: 50 },
      { pid: 50, ppid: 60 }
    ]
    expect(boundedWalk(rows, 50)).toEqual([{ pid: 60, ppid: 50, depth: 1 }])
  })

  it('ignores disconnected cycles and unrelated components', () => {
    const rows = [
      { pid: 2, ppid: 1 },
      { pid: 8, ppid: 9 },
      { pid: 9, ppid: 8 },
      { pid: 20, ppid: 19 }
    ]
    expect(boundedWalk(rows, 1)).toEqual([{ pid: 2, ppid: 1, depth: 1 }])
    expect(boundedWalk(rows, 99)).toEqual([])
    expect(boundedWalk([], 1)).toEqual([])
  })

  it('queues each PID once, retaining the first queued duplicate', () => {
    const rows = [
      { pid: 2, ppid: 1, marker: 'first' },
      { pid: 2, ppid: 1, marker: 'duplicate' },
      { pid: 3, ppid: 1, marker: 'sibling' },
      { pid: 2, ppid: 3, marker: 'other-parent' },
      { pid: 4, ppid: 2, marker: 'child' }
    ]
    expect(boundedWalk(rows, 1)).toEqual([
      { ...rows[2], depth: 1 },
      { ...rows[0], depth: 1 },
      { ...rows[4], depth: 2 }
    ])
    expect(buildProcessTableIndex(rows).byPid.get(2)).toBe(rows[0])
  })

  it('walks a deep valid tree without recursion or changing depth', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({ pid: index + 2, ppid: index + 1 }))
    expect(boundedWalk(rows, 1)).toEqual(rows.map((row, index) => ({ ...row, depth: index + 1 })))
  })

  it('preserves reverse capture order for a broad valid tree', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({ pid: index + 2, ppid: 1 }))
    expect(boundedWalk(rows, 1)).toEqual(rows.toReversed().map((row) => ({ ...row, depth: 1 })))
  })

  it('retains synthetic POSIX host identity fields through a cycle', () => {
    const rows = parseStrictProcessTableRows('5 6 5 6 S pts/1 100 bash\n6 5 6 6 S+ pts/1 200 codex')
    expect(boundedWalk(rows, 5)).toEqual([{ ...rows[1], depth: 1 }])
  })

  it('retains synthetic Windows creation markers without treating a PID as an incarnation', () => {
    const rows = [
      { pid: 5, ppid: 6, creationTimeMs: 100, name: 'pwsh.exe' },
      { pid: 6, ppid: 5, creationTimeMs: 200, name: 'node.exe' }
    ]
    expect(boundedWalk(rows, 5)).toEqual([{ ...rows[1], depth: 1 }])
  })
})
