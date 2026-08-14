import { describe, expect, it } from 'vitest'
import type { GitHubPRStack } from '../../../../shared/github/pull-request-types'
import {
  getGitHubPRStackMergeBlocker,
  getGitHubPRStackMergeScope,
  isGitHubPRStackMergeQueueRequired
} from './github-pr-stack-merge'

function makeStack(): GitHubPRStack {
  return {
    number: 51,
    position: 2,
    size: 3,
    baseRefName: 'main',
    entries: [
      {
        position: 1,
        number: 201,
        title: 'Models',
        url: 'https://example.test/201',
        state: 'open',
        checksStatus: 'success',
        mergeable: 'MERGEABLE'
      },
      {
        position: 2,
        number: 202,
        title: 'API',
        url: 'https://example.test/202',
        state: 'open',
        checksStatus: 'success',
        mergeable: 'MERGEABLE'
      },
      {
        position: 3,
        number: 203,
        title: 'UI',
        url: 'https://example.test/203',
        state: 'draft',
        checksStatus: 'neutral',
        mergeable: 'UNKNOWN'
      }
    ]
  }
}

describe('GitHub stack merge scope', () => {
  it('uses stack metadata when review metadata has not observed the merge queue', () => {
    expect(isGitHubPRStackMergeQueueRequired(false, true)).toBe(true)
  })

  it('includes the current PR and downstack entries, never upstack entries', () => {
    const scope = getGitHubPRStackMergeScope(makeStack(), 202)

    expect(scope.entries.map((entry) => entry.number)).toEqual([201, 202])
    expect(scope.complete).toBe(true)
    expect(scope.label).toBe('Merge through #202 · 2 PRs')
    expect(getGitHubPRStackMergeBlocker(scope)).toBeNull()
  })

  it('keeps the GitHub-reported merge count when entry details are incomplete', () => {
    const stack = makeStack()
    stack.entries = stack.entries?.filter((entry) => entry.position !== 1)

    const scope = getGitHubPRStackMergeScope(stack, 202)

    expect(scope.entries.map((entry) => entry.number)).toEqual([202])
    expect(scope.count).toBe(2)
    expect(scope.complete).toBe(false)
    expect(scope.label).toBe('Merge through #202 · 2 PRs')
  })

  it('surfaces the first downstack blocker', () => {
    const stack = makeStack()
    stack.entries![0] = { ...stack.entries![0]!, mergeable: 'CONFLICTING' }

    expect(getGitHubPRStackMergeBlocker(getGitHubPRStackMergeScope(stack, 202))).toBe(
      '#201 has merge conflicts.'
    )
  })
})
