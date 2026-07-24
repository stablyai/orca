import { describe, expect, it } from 'vitest'
import { RuntimeRepoFetchTracker } from './runtime-repo-fetch-tracker'

const BOUNDS = {
  maxEnvironments: 2,
  maxEnvironmentIdBytes: 4,
  maxTotalEnvironmentIdBytes: 6
}

describe('RuntimeRepoFetchTracker', () => {
  it('releases completed environments during sequential churn', () => {
    const tracker = new RuntimeRepoFetchTracker(BOUNDS)
    for (let index = 0; index < 100; index++) {
      const environmentId = String(index % 10)
      const token = tracker.begin(environmentId)
      expect(token).not.toBeNull()
      tracker.end(environmentId, token!)
    }

    expect(tracker.evidence()).toEqual({ environments: 0, keyBytes: 0 })
  })

  it('lets a replacement supersede an older request without releasing the replacement', () => {
    const tracker = new RuntimeRepoFetchTracker(BOUNDS)
    const first = tracker.begin('a')!
    const replacement = tracker.begin('a')!

    expect(tracker.isCurrent('a', first)).toBe(false)
    expect(tracker.isCurrent('a', replacement)).toBe(true)
    tracker.end('a', first)
    expect(tracker.isCurrent('a', replacement)).toBe(true)
  })

  it('rejects a new owner at capacity while allowing an existing owner replacement', () => {
    const tracker = new RuntimeRepoFetchTracker(BOUNDS)
    tracker.begin('a')
    tracker.begin('bb')

    expect(tracker.begin('c')).toBeNull()
    expect(tracker.begin('a')).not.toBeNull()
    expect(tracker.evidence()).toEqual({ environments: 2, keyBytes: 3 })
  })

  it('rejects a new owner beyond the aggregate id budget', () => {
    const tracker = new RuntimeRepoFetchTracker({
      maxEnvironments: 3,
      maxEnvironmentIdBytes: 4,
      maxTotalEnvironmentIdBytes: 3
    })
    tracker.begin('aa')
    tracker.begin('b')

    expect(tracker.begin('c')).toBeNull()
    expect(tracker.evidence()).toEqual({ environments: 2, keyBytes: 3 })
  })

  it('rejects environment ids outside the byte budget', () => {
    const tracker = new RuntimeRepoFetchTracker(BOUNDS)

    expect(tracker.begin('oversized')).toBeNull()
    expect(tracker.evidence()).toEqual({ environments: 0, keyBytes: 0 })
  })
})
