import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'

import { workItemsCacheKey, type CacheEntry } from '@/store/slices/github'
import type { GitHubWorkItem, LinearIssue } from '../../../shared/types'
import {
  buildTaskPageRepoSourceState,
  findTaskPageDialogWorkItem,
  findTaskPageLinearDrawerIssue,
  selectTaskPageWorkItemsCacheEntries
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
  it('keeps the selected work-item cache slice shallow-equal across unrelated cache writes', () => {
    const repo = { id: 'repo-1', path: '/repo/one' }
    const selectedEntry = entry<GitHubWorkItem[]>([workItem('issue-1', 'repo-1')])
    const firstCache = {
      [workItemsCacheKey(repo.path, 20, '')]: selectedEntry
    }
    const secondCache = {
      ...firstCache,
      [workItemsCacheKey('/repo/two', 20, '')]: entry<GitHubWorkItem[]>([
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

  it('returns null while the GitHub dialog is closed so cache writes do not re-render it', () => {
    const item = workItem('issue-1', 'repo-1')
    const cache = {
      [workItemsCacheKey('/repo/one', 20, '')]: entry<GitHubWorkItem[]>([item])
    }

    expect(findTaskPageDialogWorkItem(cache, null)).toBeNull()
    expect(findTaskPageDialogWorkItem(cache, { id: 'issue-1', repoId: 'repo-1' })).toBe(item)
    expect(findTaskPageDialogWorkItem(cache, { id: 'issue-1', repoId: 'repo-2' })).toBeNull()
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
