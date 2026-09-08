import { describe, expect, it } from 'vitest'
import { retargetGitHubPrStartPointSelection } from './useComposerState'

describe('useComposerState host retarget', () => {
  it('re-resolves a seeded PR after switching its run host', () => {
    const item = {
      id: 'pr-42',
      type: 'pr' as const,
      number: 42,
      title: 'Fix PR workspace creation',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/42',
      labels: [],
      updatedAt: '2026-08-04T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-local'
    }
    const selection = {
      repoId: 'repo-local',
      item,
      resolved: {
        baseBranch: 'local-head',
        compareBaseRef: 'origin/main'
      }
    }

    expect(retargetGitHubPrStartPointSelection(selection, 'repo-ssh')).toEqual({
      repoId: 'repo-ssh',
      item
    })
  })
})
