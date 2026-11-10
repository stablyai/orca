import { describe, expect, it } from 'vitest'
import {
  canShowGitHubPRAutoMergeControl,
  type GitHubPRAutoMergeAvailabilityInput
} from './pull-request-auto-merge-availability'

function pr(
  overrides: Partial<GitHubPRAutoMergeAvailabilityInput> = {}
): GitHubPRAutoMergeAvailabilityInput {
  return {
    state: 'open',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeAllowed: true,
    ...overrides
  }
}

describe('github PR auto-merge availability', () => {
  it.each([undefined, null, 'UNKNOWN', 'FUTURE_STATUS'])(
    'does not infer an auto-merge requirement from unresolved status %s',
    (mergeStateStatus) => {
      const item = pr({ mergeable: 'UNKNOWN', mergeStateStatus })
      expect(canShowGitHubPRAutoMergeControl(item)).toBe(false)
    }
  )

  it('does not offer auto-merge for directly mergeable PRs with only optional checks pending', () => {
    expect(canShowGitHubPRAutoMergeControl(pr())).toBe(false)
  })

  it('offers auto-merge for requirement-blocked PRs', () => {
    expect(
      canShowGitHubPRAutoMergeControl(
        pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })
      )
    ).toBe(true)
    expect(canShowGitHubPRAutoMergeControl(pr({ mergeStateStatus: 'BLOCKED' }))).toBe(true)
    expect(canShowGitHubPRAutoMergeControl(pr({ mergeStateStatus: 'BEHIND' }))).toBe(true)
    expect(
      canShowGitHubPRAutoMergeControl(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' }))
    ).toBe(true)
  })

  it('keeps merge-queue branches available for merge-when-ready', () => {
    expect(canShowGitHubPRAutoMergeControl(pr({ mergeQueueRequired: true }))).toBe(true)
    expect(
      canShowGitHubPRAutoMergeControl(pr({ autoMergeAllowed: false, mergeQueueRequired: true }))
    ).toBe(true)
    expect(
      canShowGitHubPRAutoMergeControl(
        pr({ mergeStateStatus: 'UNSTABLE', mergeQueueRequired: true })
      )
    ).toBe(true)
  })

  it('keeps enabled auto-merge visible so users can disable it', () => {
    expect(canShowGitHubPRAutoMergeControl(pr({ autoMergeEnabled: true }))).toBe(true)
    expect(
      canShowGitHubPRAutoMergeControl(
        pr({
          autoMergeEnabled: true,
          autoMergeAllowed: false,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY'
        })
      )
    ).toBe(true)
  })

  it('suppresses closed, draft, disallowed, conflicting, and unstable PRs', () => {
    expect(
      canShowGitHubPRAutoMergeControl(pr({ state: 'draft', mergeStateStatus: 'BLOCKED' }))
    ).toBe(false)
    expect(canShowGitHubPRAutoMergeControl(pr({ state: 'closed', autoMergeEnabled: true }))).toBe(
      false
    )
    expect(
      canShowGitHubPRAutoMergeControl(
        pr({ autoMergeAllowed: false, mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' })
      )
    ).toBe(false)
    expect(
      canShowGitHubPRAutoMergeControl(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))
    ).toBe(false)
    expect(
      canShowGitHubPRAutoMergeControl(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNSTABLE' }))
    ).toBe(false)
  })
})
