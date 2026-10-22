import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { selectTaskPageWorkItemsCacheEntries } from '../../components/task-page-cache-selectors'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
// Why no executionHostId: older SSH rows carry only connectionId.
const sshRow: Repo = { ...localRow, path: '/remote/twin', addedAt: 2, connectionId: 'builder' }
const sources = {
  issues: { owner: 'o', repo: 'r' },
  prs: { owner: 'o', repo: 'r' },
  originCandidate: { owner: 'o', repo: 'r' },
  upstreamCandidate: null
}

function pr(number: number): Omit<GitHubWorkItem, 'repoId'> {
  return {
    id: `pr-${number}`,
    type: 'pr',
    number,
    title: `PR ${number}`,
    state: 'open',
    url: `https://github.com/o/r/pull/${number}`,
    labels: [],
    updatedAt: '2026-10-20T00:00:00Z',
    author: 'octo'
  }
}

describe('work-item cache for a repo id on this computer and over SSH', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.listWorkItems.mockImplementation(async (args: { repoPath: string }) => ({
      items: [pr(args.repoPath === sshRow.path ? 2 : 1)],
      sources
    }))
  })

  it('keeps each twin in its own bucket, and a source-less reader reads each one back', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow] })

    await store.getState().fetchWorkItems('twin', localRow.path, 24, '')
    await store.getState().fetchWorkItems('twin', sshRow.path, 24, '')

    const entries = selectTaskPageWorkItemsCacheEntries(
      store.getState().workItemsCache,
      [localRow, sshRow].map(({ id, path, connectionId, executionHostId }) => ({
        id,
        path,
        connectionId,
        executionHostId
      })),
      24,
      ''
    )
    expect(entries.map((entry) => entry?.data?.map((item) => item.number))).toEqual([[1], [2]])
  })

  it('keys a row with no host stamp as local, whichever server is focused', async () => {
    const store = createTestStore()
    store.setState({
      repos: [localRow],
      settings: { ...store.getState().settings!, activeRuntimeEnvironmentId: 'focused' }
    })

    await store.getState().fetchWorkItems('twin', localRow.path, 24, '')

    const [entry] = selectTaskPageWorkItemsCacheEntries(
      store.getState().workItemsCache,
      [{ id: localRow.id, path: localRow.path }],
      24,
      ''
    )
    expect(entry?.data?.map((item) => item.number)).toEqual([1])
  })

  it('serves the SSH twin its own cached rows, not the local twin’s', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow] })

    await store.getState().fetchWorkItems('twin', localRow.path, 24, '')

    expect(store.getState().getCachedWorkItems('twin', 24, '', sshRow.path)).toBeNull()
  })
})
