import { describe, expect, it } from 'vitest'
import { addTrackedBranch, normalizeTrackedBranches, removeTrackedBranch } from './tracked-branches'

describe('normalizeTrackedBranches', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeTrackedBranches(undefined)).toEqual([])
    expect(normalizeTrackedBranches(null)).toEqual([])
    expect(normalizeTrackedBranches('task/x')).toEqual([])
    expect(normalizeTrackedBranches({ 0: 'task/x' })).toEqual([])
  })

  it('trims and strips refs/heads/', () => {
    expect(normalizeTrackedBranches(['  task/WOLF-2081-v1.15.0  ', 'refs/heads/task/x'])).toEqual([
      'task/WOLF-2081-v1.15.0',
      'task/x'
    ])
  })

  it('drops non-strings, empties, and names git would reject', () => {
    expect(
      normalizeTrackedBranches([
        42,
        null,
        '',
        '   ',
        'has space',
        'caret^ref',
        'colon:ref',
        'quest?ref',
        'star*ref',
        'bracket[ref',
        'back\\slash',
        'dot..dot',
        'at@{ref',
        'ends/',
        '/starts',
        'ends.lock',
        'ctrl\u0007ref',
        'del\u007fref',
        'ok/branch'
      ])
    ).toEqual(['ok/branch'])
  })

  it('dedupes preserving first occurrence', () => {
    expect(normalizeTrackedBranches(['a', 'b', 'refs/heads/a', ' a '])).toEqual(['a', 'b'])
  })

  it('caps the list at 20 entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => `branch-${i}`)
    expect(normalizeTrackedBranches(many)).toHaveLength(20)
  })

  it('drops names longer than 250 chars', () => {
    expect(normalizeTrackedBranches(['x'.repeat(251), 'y'.repeat(250)])).toEqual(['y'.repeat(250)])
  })
})

describe('addTrackedBranch', () => {
  it('appends a new branch', () => {
    expect(addTrackedBranch(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('is a no-op for an already-tracked branch, including ref-form input', () => {
    expect(addTrackedBranch(['a', 'b'], 'refs/heads/a')).toEqual(['a', 'b'])
  })

  it('works from undefined', () => {
    expect(addTrackedBranch(undefined, 'task/x')).toEqual(['task/x'])
  })
})

describe('removeTrackedBranch', () => {
  it('removes by normalized name', () => {
    expect(removeTrackedBranch(['a', 'b'], 'refs/heads/b')).toEqual(['a'])
  })

  it('leaves the list untouched when the branch is absent or unusable', () => {
    expect(removeTrackedBranch(['a'], 'zz')).toEqual(['a'])
    expect(removeTrackedBranch(['a'], '')).toEqual(['a'])
  })
})
