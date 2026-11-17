import { describe, expect, it } from 'vitest'
import { cachedDeleteStatusIsTrustworthy } from './delete-worktree-dirty-change-counts'

describe('cachedDeleteStatusIsTrustworthy', () => {
  it('trusts a local cached status whose last read succeeded', () => {
    expect(cachedDeleteStatusIsTrustworthy({ hostId: undefined, readError: undefined })).toBe(true)
  })

  it('does not trust a local cached status whose last read failed (#43678)', () => {
    expect(
      cachedDeleteStatusIsTrustworthy({ hostId: undefined, readError: 'Git command failed' })
    ).toBe(false)
  })

  it('host-qualified targets never trust a local cache; they always fetch fresh', () => {
    expect(cachedDeleteStatusIsTrustworthy({ hostId: 'runtime:env' })).toBe(false)
  })
})
