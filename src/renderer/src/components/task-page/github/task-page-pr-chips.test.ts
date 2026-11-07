import { describe, expect, it } from 'vitest'
import { gitHubPRWhoChange, matchGitHubPRPreset, patchGitHubTaskQuery } from './task-page-pr-chips'

describe('GitHub PR state × who chips', () => {
  it('applies a preset-equal combination as that preset and keeps any other filter custom', () => {
    const mine = patchGitHubTaskQuery(
      patchGitHubTaskQuery('is:pr is:merged', { state: 'open' }),
      gitHubPRWhoChange('mine')
    )
    expect(matchGitHubPRPreset(mine)).toBe('my-prs')
    const labelled = patchGitHubTaskQuery('is:pr is:open label:bug fix', gitHubPRWhoChange('mine'))
    expect(labelled).toBe('is:pr is:open author:@me label:bug fix')
    expect(matchGitHubPRPreset(labelled)).toBeNull()
    expect(patchGitHubTaskQuery('is:pr is:open is:draft', { state: 'merged' })).toBe(
      'is:pr is:merged'
    )
  })
})
