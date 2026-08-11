import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GIT_STATUS_LIMIT,
  capGitStatusEntries,
  resolveGitStatusLimit
} from './git-status-limit'

describe('resolveGitStatusLimit', () => {
  it('accepts non-negative integers and rejects malformed limits', () => {
    expect(resolveGitStatusLimit(0)).toBe(0)
    expect(resolveGitStatusLimit(25)).toBe(25)
    expect(resolveGitStatusLimit(1.5)).toBe(DEFAULT_GIT_STATUS_LIMIT)
    expect(resolveGitStatusLimit(Number.NaN)).toBe(DEFAULT_GIT_STATUS_LIMIT)
    expect(resolveGitStatusLimit(-1)).toBe(DEFAULT_GIT_STATUS_LIMIT)
  })
})

describe('capGitStatusEntries', () => {
  it('caps composed entries and reports the observed size', () => {
    expect(capGitStatusEntries(['a', 'b', 'c'], 2)).toEqual({
      entries: ['a', 'b'],
      didHitLimit: true,
      statusLength: 3
    })
  })

  it('preserves an earlier incomplete-status signal after deduplication', () => {
    expect(capGitStatusEntries(['a'], 2, { didHitLimit: true, statusLength: 3 })).toEqual({
      entries: ['a'],
      didHitLimit: true,
      statusLength: 3
    })
  })

  it('treats zero as an unlimited result', () => {
    expect(capGitStatusEntries(['a', 'b'], 0)).toEqual({ entries: ['a', 'b'] })
  })
})
