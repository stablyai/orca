import { describe, expect, it } from 'vitest'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import { otherOpenLinkedPullRequests } from './linked-issue-other-pull-requests'

function linked(number: number, headRefName: string) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/stablyai/orca/pull/${number}`,
    author: 'lesbass',
    headRefName,
    createdAt: '2026-10-13T20:01:09Z'
  }
}

const issue: IssueInfo = {
  number: 28343,
  title: 'Clicking host menu items toggles the host accordion',
  state: 'open',
  url: 'https://github.com/stablyai/orca/issues/28343',
  labels: [],
  openLinkedPullRequests: [
    linked(28628, 'fix/host-menu-actions'),
    linked(28401, 'petersindex/fix-host-menu'),
    linked(28399, 'mine-under-another-number')
  ]
}

describe('otherOpenLinkedPullRequests', () => {
  it("leaves out the workspace's own PR, matched by number or by branch", () => {
    expect(
      otherOpenLinkedPullRequests(issue, {
        ownReviewNumber: 28399,
        branch: 'refs/heads/petersindex/fix-host-menu'
      }).map((pr) => pr.number)
    ).toEqual([28628])
  })

  it('treats every open PR as another one when the workspace has no PR yet', () => {
    expect(
      otherOpenLinkedPullRequests(issue, { ownReviewNumber: null, branch: 'local-only' }).map(
        (pr) => pr.number
      )
    ).toEqual([28628, 28401, 28399])
  })

  it('returns nothing when the linked PRs were not fetched', () => {
    expect(
      otherOpenLinkedPullRequests(
        { ...issue, openLinkedPullRequests: undefined },
        { ownReviewNumber: null, branch: 'local-only' }
      )
    ).toEqual([])
  })
})
