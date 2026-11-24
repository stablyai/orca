import { describe, expect, it } from 'vitest'
import { confirmedGitHubChecks } from './bot-item-github-peek-content'

const updatedAt = '2026-11-23T10:00:00.000Z'
const changed = Date.parse(updatedAt)

// A PR's card shows checks only as confirmed for the PR its lookup returned: never an older reading,
// which may belong to an earlier push, beside a newer title as if current.
describe('confirmedGitHubChecks', () => {
  it("shows the chip's reading when it was taken since the PR last changed", () => {
    expect(confirmedGitHubChecks('success', changed + 1, { updatedAt })).toBe('success')
    expect(confirmedGitHubChecks('failure', changed, { updatedAt })).toBe('failure')
  })

  it('shows none when the PR changed after the reading, or it was never read', () => {
    expect(confirmedGitHubChecks('success', changed - 1, { updatedAt })).toBeNull()
    expect(confirmedGitHubChecks('success', null, { updatedAt })).toBeNull()
  })

  it("prefers the lookup's own summary", () => {
    const checksSummary = {
      state: 'failure' as const,
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      neutral: 0
    }
    expect(confirmedGitHubChecks('success', changed + 1, { updatedAt, checksSummary })).toBe(
      'failure'
    )
  })
})
