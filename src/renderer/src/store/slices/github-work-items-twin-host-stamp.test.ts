import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
const sshRow: Repo = { ...localRow, path: '/remote/twin', addedAt: 2, connectionId: 'builder' }
const item: Omit<GitHubWorkItem, 'repoId'> = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Fix it',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octo'
}
const sources = {
  issues: { owner: 'o', repo: 'r' },
  prs: { owner: 'o', repo: 'r' },
  originCandidate: { owner: 'o', repo: 'r' },
  upstreamCandidate: null
}

describe('work items fetched for a repo id two hosts share', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [item], sources })
  })

  it('carry the host of the row that returned them, on the first page', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow] })

    const result = await store
      .getState()
      .fetchWorkItemsAcrossRepos([{ repoId: 'twin', path: '/remote/twin' }], 24, 100, '')

    expect(result.items.map((entry) => entry.repoHostId)).toEqual(['ssh:builder'])
  })

  it('carry the host of the row that returned them, on later pages', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow] })

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'twin', path: '/remote/twin' }], 24, 100, '', 1)

    expect(result.items.map((entry) => entry.repoHostId)).toEqual(['ssh:builder'])
  })
})
