import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import { materializeTaskPageItemList } from './task-page-github-work-item-mutation-pages'

function item(number: number, updatedAt: string): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title: `#${number}`,
    state: 'open',
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    updatedAt,
    author: 'author',
    repoId: 'repo-1'
  }
}

describe('materializeTaskPageItemList', () => {
  it('keeps host issue-number order when an older issue was updated later', () => {
    const newest = item(80, '2026-11-01T00:00:00Z')
    const triaged = item(12, '2026-11-13T00:00:00Z')
    const listed = materializeTaskPageItemList({
      networkItems: [newest, triaged],
      previousItems: [triaged, newest],
      queryKey: 'open'
    })
    expect(listed.map((row) => row.number)).toEqual([80, 12])
  })
})
