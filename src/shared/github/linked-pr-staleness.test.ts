import { describe, expect, it } from 'vitest'
import type { PRInfo } from './pull-request-types'
import { shouldClearBranchMismatchedLinkedOpenPR } from './linked-pr-staleness'

const openPR: PRInfo = {
  number: 2383,
  title: 'Frontend change',
  state: 'open',
  url: 'https://github.com/relayto/relayto-frontend/pull/2383',
  checksStatus: 'success',
  updatedAt: '2026-01-01T00:00:00Z',
  mergeable: 'MERGEABLE',
  headRefName: 'frontend-feature',
  headSha: 'pr-head'
}
const args = {
  linkedPRNumber: 2383,
  branch: 'refs/heads/main',
  requestHeadOid: 'worktree-head',
  pushTargetBranch: null
}

describe('shouldClearBranchMismatchedLinkedOpenPR', () => {
  it('keeps a PR linked from another repository, whose branches never name this worktree', () => {
    expect(shouldClearBranchMismatchedLinkedOpenPR({ ...args, pr: openPR })).toBe(true)
    expect(
      shouldClearBranchMismatchedLinkedOpenPR({
        ...args,
        pr: { ...openPR, linkedFromOtherRepository: true }
      })
    ).toBe(false)
  })
})
