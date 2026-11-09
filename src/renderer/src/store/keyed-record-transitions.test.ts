import { describe, expect, it } from 'vitest'
import {
  annotateTabBucketReplacement,
  markFullResync,
  readRecordChanges,
  readTabMapChanges,
  replaceMapEntries,
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
      tabIds: new Set(['a2']),
      workspaceSetChanged: false,
      addedWorkspaceIds: [],
      deletedWorkspaceIds: new Set()
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
      tabIds: new Set(['a2', 'c1']),
      workspaceSetChanged: true,
      addedWorkspaceIds: ['c'],
      deletedWorkspaceIds: new Set()
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

  it('reads a builder that declares a move as reordered, and refuses an undeclared one', () => {
    const start = { a: [a1], b: [b1] }
    const { a: _a, ...rest } = start
    const moved = annotateTabBucketReplacement(start, { ...rest, a: [a1, a2] }, ['a'], 'reordered')
    expect(readTabMapChanges(moved, start)).toEqual({ kind: 'full-resync', reason: 'reordered' })
    expect(() => annotateTabBucketReplacement(start, { ...rest, a: [a1, a2] }, ['a'])).toThrow(
      "annotate it with order 'reordered'"
    )
  })

  it('reports keys added across a chain in source order, index keys first', () => {
    const start = { base: 1 }
    const one = replaceRecordEntries(start, [['earlier', 2]])
    const two = replaceRecordEntries(one, [
      ['later', 3],
      ['7', 4]
    ])
    expect(Object.keys(two)).toEqual(['7', 'base', 'earlier', 'later'])
    const changes = readRecordChanges(two, start)
    expect(changes?.kind === 'addressed' && changes.added).toEqual(['7', 'earlier', 'later'])
  })

  it('keeps modified keys out of the ordered additions; survivors keep their source order', () => {
    const start = { a: 1, b: 1 }
    const one = replaceRecordEntries(start, [['c', 1]])
    const two = replaceRecordEntries(one, [
      ['b', 2],
      ['a', 2]
    ])
    expect(Object.keys(two)).toEqual(['a', 'b', 'c'])
    expect(readRecordChanges(two, start)).toEqual({
      kind: 'addressed',
      keys: new Set(['c', 'b', 'a']),
      added: ['c'],
      deleted: new Set()
    })
  })

  it('reads a delete then re-add of a surviving key as reordered, across a chain or in one write', () => {
    const start = { earlier: 1, later: 2 }
    const removed = replaceRecordEntries(start, [['earlier', null]])
    const readded = replaceRecordEntries(removed, [['earlier', 1]])
    expect(Object.keys(readded)).toEqual(['later', 'earlier'])
    expect(readRecordChanges(readded, start)).toEqual({ kind: 'full-resync', reason: 'reordered' })
    const sameWrite = replaceRecordEntries(start, [
      ['earlier', null],
      ['earlier', 1]
    ])
    expect(readRecordChanges(sameWrite, start)).toEqual({
      kind: 'full-resync',
      reason: 'reordered'
    })
  })

  it('tracks Map-typed fields with the same protocol', () => {
    const start = new Map([
      ['env-1', 'online'],
      ['env-2', 'online']
    ])
    const next = replaceMapEntries(start, [
      ['env-1', 'revoked'],
      ['env-2', null],
      ['env-3', 'online']
    ])
    expect([...next]).toEqual([
      ['env-1', 'revoked'],
      ['env-3', 'online']
    ])
    expect(readRecordChanges(next, start)).toEqual({
      kind: 'addressed',
      keys: new Set(['env-1', 'env-2', 'env-3']),
      added: ['env-3'],
      deleted: new Set(['env-2'])
    })
    expect(readRecordChanges(new Map(next), start)).toEqual({
      kind: 'full-resync',
      reason: 'unknown'
    })
  })

  it('names deleted record keys', () => {
    const start = { t1: 'pty-1', t2: 'pty-2' }
    const next = replaceRecordEntries(start, [['t1', null]])
    expect(next).toEqual({ t2: 'pty-2' })
    expect(readRecordChanges(next, start)).toEqual({
      kind: 'addressed',
      keys: new Set(['t1']),
      added: [],
      deleted: new Set(['t1'])
    })
  })

  it('refuses an annotation that omits a changed bucket', () => {
    const start = { a: [a1], b: [b1] }
    expect(() => annotateTabBucketReplacement(start, { a: [a1, a2], b: [] }, ['a'])).toThrow(
      'unnamed key b'
    )
  })
})
