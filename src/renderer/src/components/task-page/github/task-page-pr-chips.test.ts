import { describe, expect, it } from 'vitest'
import { parseTaskQuery } from '../../../../../shared/task-query'
import { getTaskPresetQuery } from '../../../../../shared/task-preset-query'
import {
  deriveGitHubPRStateChip,
  deriveGitHubPRWhoChip,
  gitHubPRWhoChange,
  matchGitHubPRPreset,
  patchGitHubTaskQuery
} from './task-page-pr-chips'

function chips(query: string) {
  const parsed = parseTaskQuery(query)
  return [deriveGitHubPRStateChip(parsed), deriveGitHubPRWhoChip(parsed)]
}

describe('GitHub PR state × who chips', () => {
  it('lights the open row for each saved preset and nothing for someone else', () => {
    expect(chips(getTaskPresetQuery('prs'))).toEqual(['open', 'everyone'])
    expect(chips(getTaskPresetQuery('my-prs'))).toEqual(['open', 'mine'])
    expect(chips(getTaskPresetQuery('review'))).toEqual(['open', 'reviewing'])
    expect(chips('is:pr is:merged author:alice')).toEqual(['merged', null])
    expect(chips('is:pr assignee:bob')).toEqual(['all', 'everyone'])
  })

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
