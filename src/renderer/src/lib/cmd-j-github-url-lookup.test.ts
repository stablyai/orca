import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

const { lookupGitHubWorkItemByOwnerRepoForSource } = vi.hoisted(() => ({
  lookupGitHubWorkItemByOwnerRepoForSource: vi.fn()
}))

vi.mock('./github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource
}))

import { lookupCmdJGitHubUrlWorkItem } from './cmd-j-github-url-lookup'

const item = {
  id: 'issue-14198',
  type: 'issue',
  number: 14198,
  title: 'Agent terminals disappearing randomly',
  state: 'open',
  url: 'https://github.com/stablyai/orca/issues/14198',
  labels: [],
  updatedAt: '2026-08-12T12:00:00.000Z',
  author: 'nwparker',
  repoId: 'repo-1'
} satisfies GitHubWorkItem

describe('lookupCmdJGitHubUrlWorkItem', () => {
  beforeEach(() => {
    lookupGitHubWorkItemByOwnerRepoForSource.mockReset()
  })

  it('looks up by owner/repo and returns null without a repo or on failure', async () => {
    const link = {
      slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      type: 'issue' as const,
      number: 14198
    }
    expect(
      await lookupCmdJGitHubUrlWorkItem({
        link,
        repo: null,
        sourceContext: null
      })
    ).toBeNull()

    lookupGitHubWorkItemByOwnerRepoForSource.mockResolvedValue(item)
    expect(
      await lookupCmdJGitHubUrlWorkItem({
        link,
        repo: { id: 'repo-1', path: '/repos/repo-1' },
        sourceContext: null
      })
    ).toEqual(item)
    expect(lookupGitHubWorkItemByOwnerRepoForSource).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com',
        number: 14198,
        type: 'issue'
      })
    )

    lookupGitHubWorkItemByOwnerRepoForSource.mockRejectedValue(new Error('offline'))
    expect(
      await lookupCmdJGitHubUrlWorkItem({
        link,
        repo: { id: 'repo-1', path: '/repos/repo-1' },
        sourceContext: null
      })
    ).toBeNull()
  })
})
