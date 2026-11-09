import { describe, expect, it } from 'vitest'
import type { CacheEntry } from '@/store/github/cache/cache-model'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { reconcileTaskPagePagesWithWorkItemsCache } from './task-page-cache-selectors'

function entry<T>(data: T): CacheEntry<T> {
  return { data, fetchedAt: 1 }
}

function workItem(id: string, repoId: string): GitHubWorkItem {
  return { id, repoId, title: id } as GitHubWorkItem
}

describe('task page cache selectors', () => {
  it('keeps each twin host row on its own copy when the cache syncs the table', () => {
    const local = { ...workItem('pr:7', 'twin'), repoHostId: 'local' as const }
    const remote = { ...local, repoHostId: 'ssh:builder' as const }
    const pages = [[local, { ...remote }]]

    const nextPages = reconcileTaskPagePagesWithWorkItemsCache(pages, [
      entry<GitHubWorkItem[]>([local]),
      entry<GitHubWorkItem[]>([remote])
    ])

    expect(nextPages[0]?.map((item) => item.repoHostId)).toEqual(['local', 'ssh:builder'])
    expect(nextPages[0]?.[1]).toBe(remote)
  })
})
