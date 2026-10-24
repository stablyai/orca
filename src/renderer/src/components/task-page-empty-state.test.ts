import { describe, expect, it } from 'vitest'
import { getRepoBackedTaskEmptyState } from './task-page-empty-state'

describe('getRepoBackedTaskEmptyState', () => {
  it('explains when no repo-backed task source is selected', () => {
    expect(
      getRepoBackedTaskEmptyState({
        provider: 'github',
        selectedRepoCount: 0
      })
    ).toEqual({
      title: 'No project sources selected',
      description:
        'Select at least one project source so Orca knows which host/account to fetch tasks from.'
    })
  })

  it('keeps GitHub no-match copy when sources are selected', () => {
    expect(
      getRepoBackedTaskEmptyState({
        provider: 'github',
        selectedRepoCount: 2
      })
    ).toEqual({
      title: 'No matching GitHub work',
      description: 'Change the query or clear it.'
    })
  })

  it('names the other forge when every selected project is hosted there', () => {
    expect(
      getRepoBackedTaskEmptyState({ provider: 'github', selectedRepoCount: 2, sourceRepoCount: 0 })
    ).toEqual({
      title: 'No GitHub projects selected',
      description: 'The selected projects are hosted on GitLab. Select a project hosted on GitHub.'
    })
    expect(
      getRepoBackedTaskEmptyState({
        provider: 'gitlab',
        selectedRepoCount: 1,
        sourceRepoCount: 0,
        gitlabView: 'issues'
      })
    ).toEqual({
      title: 'No GitLab projects selected',
      description: 'The selected projects are hosted on GitHub. Select a project hosted on GitLab.'
    })
  })

  it('keeps no-match copy while at least one selected project is queried', () => {
    expect(
      getRepoBackedTaskEmptyState({ provider: 'github', selectedRepoCount: 3, sourceRepoCount: 1 })
    ).toEqual({
      title: 'No matching GitHub work',
      description: 'Change the query or clear it.'
    })
  })

  it('uses GitLab view-specific no-match copy when sources are selected', () => {
    expect(
      getRepoBackedTaskEmptyState({
        provider: 'gitlab',
        selectedRepoCount: 1,
        gitlabView: 'mrs'
      })
    ).toEqual({
      title: 'No GitLab merge requests',
      description: 'No GitLab MRs match this filter.'
    })
  })
})
