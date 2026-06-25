import { describe, expect, it } from 'vitest'
import { GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES } from './github-work-item-option-filter-bounds'
import { filterGitHubWorkItemAssignees } from './github-work-item-assignee-filter'

describe('filterGitHubWorkItemAssignees', () => {
  const assignees = [
    { login: 'alice', name: 'Alice Smith', avatarUrl: 'https://example.com/alice.png' },
    { login: 'bob', name: 'Bob Jones', avatarUrl: 'https://example.com/bob.png' },
    { login: 'carol', name: null, avatarUrl: 'https://example.com/carol.png' }
  ]

  it('returns all assignees when the query is empty', () => {
    expect(filterGitHubWorkItemAssignees(assignees, '')).toEqual(assignees)
    expect(filterGitHubWorkItemAssignees(assignees, '   ')).toEqual(assignees)
  })

  it('matches logins case-insensitively', () => {
    expect(filterGitHubWorkItemAssignees(assignees, 'BOB')).toEqual([assignees[1]])
  })

  it('matches display names case-insensitively', () => {
    expect(filterGitHubWorkItemAssignees(assignees, 'smith')).toEqual([assignees[0]])
    expect(filterGitHubWorkItemAssignees(assignees, 'jones')).toEqual([assignees[1]])
  })

  it('rejects oversized pasted queries before reading assignees', () => {
    const oversizedQuery = 'secret-assignee-filter'.repeat(
      GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES
    )
    const throwingAssignees = [
      {
        get login(): string {
          throw new Error('oversized assignee filters must not scan logins')
        },
        get name(): string {
          throw new Error('oversized assignee filters must not scan names')
        },
        avatarUrl: 'https://example.com/secret.png'
      }
    ]

    expect(filterGitHubWorkItemAssignees(throwingAssignees, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    expect(
      filterGitHubWorkItemAssignees(
        assignees,
        ' '.repeat(GITHUB_WORK_ITEM_OPTION_FILTER_QUERY_MAX_BYTES + 1)
      )
    ).toEqual([])
  })
})
