import { describe, expect, it } from 'vitest'
import { GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES } from './github-work-item-option-filter-bounds'
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

  it('rejects oversized pasted queries before reading labels', () => {
    const oversizedQuery = 'secret-label-filter'.repeat(
      GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES
    )
    const throwingLabels = [
      {
        toLowerCase(): string {
          throw new Error('oversized label filters must not scan labels')
        }
      } as string
    ]

    expect(filterGitHubWorkItemLabels(throwingLabels, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    expect(
      filterGitHubWorkItemLabels(
        ['bug'],
        ' '.repeat(GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES + 1)
      )
    ).toEqual([])
  })
})
