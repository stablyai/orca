import { describe, expect, it } from 'vitest'
import {
  annotateTabBucketReplacement,
  markFullResync,
  readRecordChanges,
  readTabMapChanges,
  replaceRecordEntries,
  replaceTabBuckets
} from './keyed-record-transitions'

const a1 = { id: 'a1' }
const a2 = { id: 'a2' }
const b1 = { id: 'b1' }

describe('keyed record transitions', () => {
  it('names the replaced buckets and the tabs that changed in them', () => {
    const start = { a: [a1, a2], b: [b1] }
    const renamed = { id: 'a2', label: 'renamed' }
    const next = replaceTabBuckets(start, [['a', [a1, renamed]]])
    expect(readTabMapChanges(next, start)).toEqual({
      kind: 'addressed',
      workspaceIds: new Set(['a']),
      tabIds: new Set(['a2'])
    })
    expect(next.b).toBe(start.b)
  })

  it('unions a chain of annotated writes and covers both owners of a move', () => {
    const start = { a: [a1, a2], b: [b1] }
    const created = replaceTabBuckets(start, [['c', [{ id: 'c1' }]]])
    const moved = replaceTabBuckets(created, [
      ['a', [a1]],
      ['b', [b1, a2]]
    ])
    expect(readTabMapChanges(moved, start)).toEqual({
      kind: 'addressed',
      workspaceIds: new Set(['a', 'b', 'c']),
      tabIds: new Set(['a2', 'c1'])
    })
  })

  it('reads an unannotated or cold replacement as a full resync', () => {
    const start = { a: [a1] }
    expect(readTabMapChanges({ ...start, a: [a1, a2] }, start)).toEqual({
      kind: 'full-resync',
      reason: 'unknown'
    })
    const hydrated = replaceTabBuckets(markFullResync({ a: [a2] }, 'hydration'), [['b', [b1]]])
    expect(readTabMapChanges(hydrated, start)).toEqual({ kind: 'full-resync', reason: 'hydration' })
  })

  it('names deleted record keys', () => {
    const start = { t1: 'pty-1', t2: 'pty-2' }
    const next = replaceRecordEntries(start, [['t1', null]])
    expect(next).toEqual({ t2: 'pty-2' })
    expect(readRecordChanges(next, start)).toEqual({ kind: 'addressed', keys: new Set(['t1']) })
  })

  it('refuses an annotation that omits a changed bucket', () => {
    const start = { a: [a1], b: [b1] }
    expect(() => annotateTabBucketReplacement(start, { a: [a1, a2], b: [] }, ['a'])).toThrow(
      'unnamed key b'
    )
  })
})
