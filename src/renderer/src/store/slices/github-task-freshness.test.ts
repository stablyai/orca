import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import { workItemsCacheKey } from '../github/cache-identity'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

const sources = {
  issues: { owner: 'acme', repo: 'widgets' },
  prs: { owner: 'acme', repo: 'widgets' },
  originCandidate: null,
  upstreamCandidate: null
}
const row: GitHubWorkItem = {
  id: 'issue:42',
  repoId: 'repo',
  type: 'issue',
  number: 42,
  title: 'Assign then start',
  state: 'open',
  labels: [],
  assignees: [],
  url: 'https://github.com/acme/widgets/issues/42',
  author: null,
  updatedAt: '2026-10-31T12:00:02Z'
}

describe('GitHub task search freshness at the store boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('adopts a genuinely newer external issue change', async () => {
    const store = createTestStore()
    const key = workItemsCacheKey('repo', 20, '')
    store.setState({ workItemsCache: { [key]: { data: [row], fetchedAt: 1 } } })
    const external = { ...row, labels: ['external'], updatedAt: '2026-10-31T12:00:03Z' }
    mockApi.gh.listWorkItems.mockResolvedValue({ items: [external], sources })
    const returned = await store.getState().fetchWorkItems('repo', '/repo', 20, '', { force: true })
    expect(returned[0].labels).toEqual(['external'])
    expect(store.getState().workItemsCache[key].data?.[0].labels).toEqual(['external'])
  })
})
