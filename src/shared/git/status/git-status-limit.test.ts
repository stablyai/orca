import { describe, expect, it } from 'vitest'
import { capGitStatusEntries } from './git-status-limit'

describe('capGitStatusEntries', () => {
  it('preserves an earlier incomplete-status signal after deduplication', () => {
    expect(capGitStatusEntries(['a'], 2, { didHitLimit: true, statusLength: 3 })).toEqual({
      entries: ['a'],
      didHitLimit: true,
      statusLength: 3
    })
  })
})
