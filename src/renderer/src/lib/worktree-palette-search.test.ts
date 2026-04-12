import { describe, expect, it } from 'vitest'
import { searchCreateWorktreeAction, searchWorktrees } from './worktree-palette-search'
import type { Repo, Worktree } from '../../../shared/types'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/worktree-jump',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Jump Palette',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/repo/orca',
      displayName: 'stablyai/orca',
      badgeColor: '#22c55e',
      addedAt: 0
    }
  ]
])

describe('worktree-palette-search', () => {
  it('returns every worktree with no match metadata for an empty query', () => {
    const results = searchWorktrees([makeWorktree()], '', repoMap, null, null)

    expect(results).toEqual([
      {
        worktreeId: 'wt-1',
        matchedField: null,
        displayNameRange: null,
        branchRange: null,
        repoRange: null,
        supportingText: null
      }
    ])
  })

  it('returns a truncated comment snippet with the highlighted match range', () => {
    const results = searchWorktrees(
      [
        makeWorktree({
          comment:
            'This worktree carries the quick jump refresh implementation details for the new palette.'
        })
      ],
      'implementation',
      repoMap,
      null,
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText?.label).toBe('Comment')
    expect(results[0].supportingText?.text).toContain('implementation')
    expect(
      results[0].supportingText?.text.slice(
        results[0].supportingText.matchRange!.start,
        results[0].supportingText.matchRange!.end
      )
    ).toBe('implementation')
  })

  it('keeps PR title matches in the search result model instead of inferring them during render', () => {
    const results = searchWorktrees(
      [makeWorktree({ branch: 'refs/heads/feature/palette-refresh', linkedPR: 426 })],
      'quick jump',
      repoMap,
      {
        '/repo/orca::feature/palette-refresh': {
          data: {
            number: 426,
            title: 'Refresh the worktree quick jump palette'
          }
        }
      },
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText).toEqual({
      label: 'PR',
      text: 'Refresh the worktree quick jump palette',
      matchRange: { start: 21, end: 31 }
    })
  })

  it('matches issue numbers with a leading hash and returns issue render context', () => {
    const results = searchWorktrees(
      [makeWorktree({ linkedIssue: 304 })],
      '#304',
      repoMap,
      null,
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText).toEqual({
      label: 'Issue',
      text: 'Issue #304',
      matchRange: { start: 7, end: 10 }
    })
  })

  it('includes the create-worktree action for direct label matches', () => {
    expect(searchCreateWorktreeAction('create new')).toEqual({
      action: 'create-worktree',
      label: 'Create new worktree',
      matchRange: { start: 0, end: 10 }
    })
  })

  it('includes the create-worktree action for alias matches without fake highlights', () => {
    expect(searchCreateWorktreeAction('add worktree')).toEqual({
      action: 'create-worktree',
      label: 'Create new worktree',
      matchRange: null
    })
  })

  it('does not include the create-worktree action for partial alias fragments', () => {
    expect(searchCreateWorktreeAction('new')).toBeNull()
    expect(searchCreateWorktreeAction('work')).toBeNull()
    expect(searchCreateWorktreeAction('add work')).toBeNull()
  })

  it('omits the create-worktree action for unrelated queries', () => {
    expect(searchCreateWorktreeAction('rebasing')).toBeNull()
  })
})
