import { describe, expect, it } from 'vitest'
import { makeDetectedResult } from '../../worktrees-detected-listing-fixtures'
import { mergeDetectedWorktreesForHost } from './detected-worktree-host-merge'
import { areDetectedWorktreeResultsEqual } from './worktree-catalog-visibility'

const failed = (unavailableReason?: string) =>
  makeDetectedResult('repo-1', [], {
    authoritative: false,
    source: 'metadata-fallback',
    ...(unavailableReason ? { unavailableReason } : {})
  })

// Why: two failed scans differ only by cause; dropping that from equality would freeze the first
// reason on the header until the listing's rows or authority changed.
describe('detected listing unavailable reason', () => {
  it('is part of listing equality', () => {
    expect(areDetectedWorktreeResultsEqual(failed('distro gone'), failed('distro gone'))).toBe(true)
    expect(areDetectedWorktreeResultsEqual(failed('distro gone'), failed('mount hung'))).toBe(false)
    expect(areDetectedWorktreeResultsEqual(failed('distro gone'), failed())).toBe(false)
  })

  it('survives the host merge when only the reason changed', () => {
    const merged = mergeDetectedWorktreesForHost(
      failed('distro gone'),
      failed('mount hung'),
      'local'
    )

    expect(merged.unavailableReason).toBe('mount hung')
  })
})
