import { describe, expect, it } from 'vitest'
import { shouldClearBranchMismatchedLinkedOpenPR } from '../../../../shared/github/linked-pr-staleness'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import './github-slice-test-harness'

describe('shouldClearBranchMismatchedLinkedOpenPR', () => {
  const basePR = (overrides: Partial<PRInfo> = {}): PRInfo =>
    ({
      number: 20,
      title: 'Sample PR',
      state: 'open',
      url: 'https://github.com/o/r/pull/20',
      checksStatus: 'success',
      updatedAt: '2026-01-01T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'prhead',
      headRefName: 'feature-one',
      ...overrides
    }) as PRInfo

  const baseArgs = {
    pr: basePR(),
    linkedPRNumber: 20,
    branch: 'feature-two',
    requestHeadOid: 'otherhead',
    pushTargetBranch: null
  }

  it('keeps the link when the push target routes to the PR head branch', () => {
    expect(
      shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, pushTargetBranch: 'feature-one' })
    ).toBe(false)
  })

  it('keeps the link when the worktree HEAD is the PR head commit', () => {
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, requestHeadOid: 'prhead' })).toBe(
      false
    )
  })

  it('requires a known PR head branch and a current branch', () => {
    expect(
      shouldClearBranchMismatchedLinkedOpenPR({
        ...baseArgs,
        pr: basePR({ headRefName: undefined })
      })
    ).toBe(false)
    // Detached HEAD reports an empty branch; there is no mismatch to act on.
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, branch: '' })).toBe(false)
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, requestHeadOid: null })).toBe(
      false
    )
  })

  it('ignores lookups that resolved a different PR than the link', () => {
    expect(
      shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, pr: basePR({ number: 21 }) })
    ).toBe(false)
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, pr: null })).toBe(false)
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...baseArgs, linkedPRNumber: null })).toBe(
      false
    )
  })
})
