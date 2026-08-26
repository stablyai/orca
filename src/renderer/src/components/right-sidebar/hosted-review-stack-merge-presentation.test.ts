import { describe, it, expect } from 'vitest'
import { composeStackMergePresentation } from './hosted-review-stack-merge-presentation'
import type { GitHubPRStackMergeScope } from './github-pr-stack-merge'
import type { GitHubPRMergeStatePresentation } from '@/components/github-pr-merge-state'

const queuedPresentation: GitHubPRMergeStatePresentation = {
  label: 'Queued · #3 in line',
  tone: 'tone',
  tooltip: 'Added to the GitHub merge queue.',
  directMergeAvailable: false,
  autoMergeAction: null
}

const readyPresentation: GitHubPRMergeStatePresentation = {
  ...queuedPresentation,
  label: 'Able to merge',
  directMergeAvailable: true
}

const completeScope: GitHubPRStackMergeScope = {
  count: 2,
  complete: true,
  entries: [],
  label: 'Merge through #7 · 2 PRs'
}

describe('composeStackMergePresentation', () => {
  it('keeps a queued stack PR non-actionable instead of re-offering enqueue', () => {
    const result = composeStackMergePresentation(queuedPresentation, {
      isQueued: true,
      stackMergeScope: completeScope,
      hasStack: true,
      stackMergeLabel: 'Queue through #7 · 2 PRs',
      stackUsesMergeQueue: true
    })

    // Without the queued guard, `stackUsesMergeQueue` forces this true and the
    // merge button re-enqueues a PR that is already in the queue.
    expect(result.directMergeAvailable).toBe(false)
    expect(result).toEqual(queuedPresentation)
  })

  it('still applies the stack override for a non-queued PR', () => {
    const result = composeStackMergePresentation(readyPresentation, {
      isQueued: false,
      stackMergeScope: completeScope,
      hasStack: true,
      stackMergeLabel: 'Queue through #7 · 2 PRs',
      stackUsesMergeQueue: true
    })

    expect(result.label).toBe('Queue through #7 · 2 PRs')
    expect(result.directMergeAvailable).toBe(true)
    expect(result.autoMergeAction).toBeNull()
  })

  it('passes the presentation through when there is no stack', () => {
    expect(
      composeStackMergePresentation(readyPresentation, {
        isQueued: false,
        stackMergeScope: null,
        hasStack: false,
        stackUsesMergeQueue: false
      })
    ).toEqual(readyPresentation)
  })
})
