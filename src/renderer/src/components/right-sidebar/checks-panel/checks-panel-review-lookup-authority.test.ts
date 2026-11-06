import { describe, expect, it } from 'vitest'
import { normalizeTrustedReviewUrl } from './checks-panel-review-lookup-authority'

describe('normalizeTrustedReviewUrl', () => {
  it('rejects credential-bearing URLs so tokens never reach the browser/shell', () => {
    expect(normalizeTrustedReviewUrl('https://user:token@git.test/repo/pull/1')).toBe(null)
    expect(normalizeTrustedReviewUrl('https://user@git.test/repo/pull/1')).toBe(null)
  })
})
