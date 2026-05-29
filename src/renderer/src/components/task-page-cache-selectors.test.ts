import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'

import { workItemsCacheKey, type CacheEntry } from '@/store/slices/github'
import type { GitHubWorkItem, LinearIssue } from '../../../shared/types'
import {
  buildTaskPageRepoSourceState,
  deriveTaskPageGitHubWorkItemsFetchOptions,
  findTaskPageDialogWorkItem,
  findTaskPageLinearDrawerIssue,
  reconcileTaskPageItemsAfterLandingRefresh,
  reconcileTaskPageLinearIssuesAfterLandingRefresh,
  reconcileTaskPagePagesAfterLandingRefresh,
  reconcileTaskPagePagesWithWorkItemsCache,
  selectTaskPageWorkItemsCacheEntries,
  shouldResetTaskPagePaginationAfterLandingRefresh,
  shouldReplaceTaskPageItemsAfterRefresh
} from './task-page-cache-selectors'

function entry<T>(data: T): CacheEntry<T> {
  return { data, fetchedAt: 1 }
}

function workItem(id: string, repoId: string): GitHubWorkItem {
  return { id, repoId, title: id } as GitHubWorkItem
}

function linearIssue(id: string): LinearIssue {
  return { id, title: id } as LinearIssue
}

describe('task page cache selectors', () => {
  it('uses noCache only for nonce or preference forced GitHub work-item refreshes', () => {
    expect(deriveTaskPageGitHubWorkItemsFetchOptions(true, false)).toEqual({
      force: true,
      noCache: true
    })
    expect(deriveTaskPageGitHubWorkItemsFetchOptions(false, true)).toEqual({
      force: true,
      noCache: false
    })
    expect(deriveTaskPageGitHubWorkItemsFetchOptions(false, false)).toEqual({
      force: false,
      noCache: false
    })
  })

  it('keeps the selected work-item cache slice shallow-equal across unrelated cache writes', () => {
    const repo = { id: 'repo-1', path: '/repo/one' }
    const selectedEntry = entry<GitHubWorkItem[]>([workItem('issue-1', 'repo-1')])
    const firstCache = {
      [workItemsCacheKey(repo.id, 20, '')]: selectedEntry
    }
    const secondCache = {
      ...firstCache,
      [workItemsCacheKey('repo-2', 20, '')]: entry<GitHubWorkItem[]>([
        workItem('issue-2', 'repo-2')
      ])
    }

    const firstSelection = selectTaskPageWorkItemsCacheEntries(firstCache, [repo], 20, '')
    const secondSelection = selectTaskPageWorkItemsCacheEntries(secondCache, [repo], 20, '')

    expect(shallow(firstSelection, secondSelection)).toBe(true)
    expect(buildTaskPageRepoSourceState([repo], secondSelection)).toEqual([
      {
        repoId: 'repo-1',
        repoPath: '/repo/one',
        sources: null,
        error: null
      }
    ])
  })

  it('selects work-item cache entries by repo id, not legacy path keys', () => {
    const repo = { id: 'repo-1', path: '/same/path' }
    const repoEntry = entry<GitHubWorkItem[]>([workItem('issue-1', 'repo-1')])
    const pathEntry = entry<GitHubWorkItem[]>([workItem('stale', 'legacy')])
    const cache = {
      [workItemsCacheKey(repo.id, 20, '')]: repoEntry,
      [workItemsCacheKey(repo.path, 20, '')]: pathEntry
    }

    expect(selectTaskPageWorkItemsCacheEntries(cache, [repo], 20, '')).toEqual([repoEntry])
  })

  it('returns null while the GitHub dialog is closed so cache writes do not re-render it', () => {
    const item = workItem('issue-1', 'repo-1')
    const cache = {
      [workItemsCacheKey('/repo/one', 20, '')]: entry<GitHubWorkItem[]>([item])
    }

    expect(findTaskPageDialogWorkItem(cache, null)).toBeNull()
    expect(findTaskPageDialogWorkItem(cache, { id: 'issue-1', repoId: 'repo-1' })).toBe(item)
    expect(findTaskPageDialogWorkItem(cache, { id: 'issue-1', repoId: 'repo-2' })).toBeNull()
  })

  it('reconciles paged table rows with patched work-item cache entries', () => {
    const stale = {
      ...workItem('pr-1', 'repo-1'),
      reviewRequests: []
    }
    const patched = {
      ...stale,
      reviewRequests: [{ login: 'AmethystLiang', name: null, avatarUrl: '' }]
    }
    const otherRepoSameId = workItem('pr-1', 'repo-2')
    const pages = [[stale, otherRepoSameId]]

    const nextPages = reconcileTaskPagePagesWithWorkItemsCache(pages, [
      entry<GitHubWorkItem[]>([patched])
    ])

    expect(nextPages[0][0]).toBe(patched)
    expect(nextPages[0][1]).toBe(otherRepoSameId)
  })

  it('merges landing refresh status changes without reordering GitHub rows', () => {
    const first = {
      ...workItem('issue-1', 'repo-1'),
      state: 'open' as const,
      updatedAt: '2026-01-01'
    }
    const second = {
      ...workItem('issue-2', 'repo-1'),
      state: 'open' as const,
      updatedAt: '2026-01-02'
    }
    const refreshedSecond = { ...second, updatedAt: '2026-01-04' }
    const refreshedFirst = { ...first, state: 'closed' as const, updatedAt: '2026-01-03' }

    const next = reconcileTaskPageItemsAfterLandingRefresh(
      [first, second],
      [refreshedSecond, refreshedFirst]
    )

    expect(
      shouldReplaceTaskPageItemsAfterRefresh([first, second], [refreshedSecond, refreshedFirst])
    ).toBe(false)
    expect(next).toEqual([refreshedFirst, refreshedSecond])
  })

  it('merges landing refresh auto-merge state changes without reordering GitHub rows', () => {
    const first = {
      ...workItem('pr-1', 'repo-1'),
      type: 'pr' as const,
      state: 'open' as const,
      autoMergeEnabled: false,
      mergeQueueRequired: null,
      updatedAt: '2026-01-01'
    }
    const refreshedFirst = {
      ...first,
      autoMergeEnabled: true,
      mergeQueueRequired: true
    }

    const next = reconcileTaskPageItemsAfterLandingRefresh([first], [refreshedFirst])

    expect(next).toEqual([refreshedFirst])
    expect(shouldReplaceTaskPageItemsAfterRefresh([first], [refreshedFirst])).toBe(false)
  })

  it('replaces GitHub landing refresh rows when membership changes', () => {
    const first = workItem('issue-1', 'repo-1')
    const second = workItem('issue-2', 'repo-1')
    const third = workItem('issue-3', 'repo-1')
    const older = workItem('issue-4', 'repo-1')

    const nextPages = reconcileTaskPagePagesAfterLandingRefresh(
      [[first, second], [older]],
      [third, first]
    )

    expect(nextPages).toEqual([[third, first]])
  })

  it('resets GitHub landing refresh pagination when first-page order changes', () => {
    const first = { ...workItem('issue-1', 'repo-1'), updatedAt: '2026-01-02' }
    const second = { ...workItem('issue-2', 'repo-1'), updatedAt: '2026-01-01' }
    const older = { ...workItem('issue-3', 'repo-1'), updatedAt: '2025-12-31' }
    const refreshedSecond = { ...second, updatedAt: '2026-01-03' }

    const nextPages = reconcileTaskPagePagesAfterLandingRefresh(
      [[first, second], [older]],
      [refreshedSecond, first]
    )

    expect(
      shouldResetTaskPagePaginationAfterLandingRefresh([first, second], [refreshedSecond, first])
    ).toBe(true)
    expect(nextPages).toEqual([[refreshedSecond, first]])
  })

  it('resets GitHub landing refresh pagination when the cursor boundary changes', () => {
    const first = { ...workItem('issue-1', 'repo-1'), updatedAt: '2026-01-03' }
    const second = { ...workItem('issue-2', 'repo-1'), updatedAt: '2026-01-01' }
    const older = { ...workItem('issue-3', 'repo-1'), updatedAt: '2025-12-31' }
    const refreshedSecond = { ...second, updatedAt: '2026-01-02' }

    const nextPages = reconcileTaskPagePagesAfterLandingRefresh(
      [[first, second], [older]],
      [first, refreshedSecond]
    )

    expect(nextPages).toEqual([[first, refreshedSecond]])
  })

  it('merges Linear landing refresh status changes without reordering issues', () => {
    const first = {
      ...linearIssue('LIN-1'),
      identifier: 'ENG-1',
      url: 'https://linear.test/ENG-1',
      state: { name: 'Todo', type: 'unstarted', color: '#111111' },
      team: { id: 'team-1', name: 'Team', key: 'ENG' },
      labels: [],
      labelIds: [],
      priority: 2,
      updatedAt: '2026-01-01'
    } as LinearIssue
    const second = {
      ...first,
      id: 'LIN-2',
      identifier: 'ENG-2',
      title: 'LIN-2',
      updatedAt: '2026-01-02'
    }
    const refreshedFirst = {
      ...first,
      state: { name: 'Done', type: 'completed', color: '#222222' },
      updatedAt: '2026-01-03'
    }
    const refreshedSecond = { ...second, updatedAt: '2026-01-04' }

    const next = reconcileTaskPageLinearIssuesAfterLandingRefresh(
      [first, second],
      [refreshedSecond, refreshedFirst]
    )

    expect(next).toEqual([refreshedFirst, refreshedSecond])
  })

  it('returns null while the Linear drawer is closed and finds open issues by stable reference', () => {
    const issue = linearIssue('LIN-1')
    const searchIssue = linearIssue('LIN-2')
    const issueCache = {
      'LIN-1': entry(issue)
    }
    const searchCache = {
      assigned: entry<LinearIssue[]>([searchIssue])
    }

    expect(findTaskPageLinearDrawerIssue(issueCache, searchCache, null)).toBeNull()
    expect(findTaskPageLinearDrawerIssue(issueCache, searchCache, 'LIN-1')).toBe(issue)
    expect(findTaskPageLinearDrawerIssue({}, searchCache, 'LIN-2')).toBe(searchIssue)
  })
})
