import { describe, expect, it } from 'vitest'
import {
  changeKind,
  isWakeFailedFresh,
  parseDiffStat
} from './orca-cloud-workspace-state'

const NOW = 1_800_000_000_000

describe('diff stats, change kinds and staleness', () => {
  it('parses shortstat lines', () => {
    expect(parseDiffStat('2 files changed, 41 insertions(+), 6 deletions(-)')).toEqual({
      files: 2,
      insertions: 41,
      deletions: 6
    })
    expect(parseDiffStat('1 file changed, 1 deletion(-)')).toEqual({
      files: 1,
      insertions: 0,
      deletions: 1
    })
    expect(parseDiffStat(null)).toBeNull()
  })

  it('maps porcelain letters and the cache’s words to one kind', () => {
    expect(changeKind('M')).toBe('modified')
    expect(changeKind('modified')).toBe('modified')
    expect(changeKind('??')).toBe('untracked')
    expect(changeKind('RM')).toBe('renamed')
    expect(changeKind('weird')).toBe('unknown')
  })

  it('lets failed wakes go stale after 10 min', () => {
    const failed = {
      workspaceId: 'w',
      phase: 'failed' as const,
      source: 'open' as const,
      startedAt: 0,
      at: NOW - 11 * 60_000
    }
    expect(isWakeFailedFresh(failed, NOW)).toBe(false)
    expect(isWakeFailedFresh({ ...failed, at: NOW - 60_000 }, NOW)).toBe(true)
  })
})
