import { describe, expect, it } from 'vitest'
import { filterGitHubWorkItemLabels } from './github-work-item-label-filter'

describe('filterGitHubWorkItemLabels', () => {
  const labels = ['agent-workflow', 'bug', 'documentation', 'duplicate']

  it('returns all labels when the query is empty', () => {
    expect(filterGitHubWorkItemLabels(labels, '')).toEqual(labels)
    expect(filterGitHubWorkItemLabels(labels, '   ')).toEqual(labels)
  })

  it('matches labels case-insensitively', () => {
    expect(filterGitHubWorkItemLabels(labels, 'BUG')).toEqual(['bug'])
    expect(filterGitHubWorkItemLabels(labels, 'Doc')).toEqual(['documentation'])
  })

  it('matches partial label names', () => {
    expect(filterGitHubWorkItemLabels(labels, 'agent')).toEqual(['agent-workflow'])
    expect(filterGitHubWorkItemLabels(labels, 'dup')).toEqual(['duplicate'])
  })
})
