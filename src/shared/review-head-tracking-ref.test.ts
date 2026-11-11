import { describe, expect, it } from 'vitest'
import { reviewHeadRemoteRefComponent } from './review-head-tracking-ref'

describe('reviewHeadRemoteRefComponent', () => {
  it('separates same-named remotes pointing at different projects', () => {
    // A repointed remote must never reuse another project’s pinned PR head.
    const a = reviewHeadRemoteRefComponent('origin', 'git@github.com:org/repo.git')
    const b = reviewHeadRemoteRefComponent('origin', 'git@github.com:other/repo.git')
    expect(a).not.toBe(b)
  })
})
