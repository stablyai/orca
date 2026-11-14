import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import { materializeTaskPageItemList } from './task-page-github-work-item-mutation-pages'
import {
  deletePendingTaskPageGitHubOp,
  setPendingTaskPageGitHubOp
} from './task-page-github-work-item-mutation-registry'

function issue(number: number, updatedAt: string): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: `https://github.com/acme/orca/issues/${number}`,
    labels: [],
    updatedAt,
    author: 'octocat',
    repoId: 'repo-1'
  }
}

const pendingKey = { sourceScope: null, repoId: 'repo-1', itemId: 'issue:50', opKey: 'state' }

afterEach(() => {
  deletePendingTaskPageGitHubOp(pendingKey)
})

describe('materializeTaskPageItemList', () => {
  it('keeps issue-number order when an older issue was edited more recently', () => {
    const newest = issue(80, '2026-11-01T00:00:00Z')
    const triaged = issue(12, '2026-11-13T00:00:00Z')

    const rows = materializeTaskPageItemList({
      networkItems: [newest, triaged],
      previousItems: [],
      queryKey: 'is:issue is:open'
    })

    expect(rows.map((row) => row.number)).toEqual([80, 12])
  })

  it('places a retained pending row at its issue-number position', () => {
    const pending = issue(50, '2026-11-13T00:00:00Z')
    setPendingTaskPageGitHubOp({
      generation: 1,
      key: pendingKey,
      previous: { state: 'open' },
      next: { state: 'closed' },
      skipMeQualifiers: false,
      startedAt: 0
    })

    const rows = materializeTaskPageItemList({
      networkItems: [issue(80, '2026-11-01T00:00:00Z'), issue(12, '2026-11-02T00:00:00Z')],
      previousItems: [pending],
      queryKey: 'is:issue is:open'
    })

    expect(rows.map((row) => row.number)).toEqual([80, 50, 12])
  })
})
