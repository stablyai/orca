import { beforeEach, describe, expect, it, vi } from 'vitest'
import { githubTaskBinding } from '@/lib/github-task-observation'
import { findRepoForGitHubOwner } from '../repositories/repository-routing'
import { workItemsCacheKey } from '../cache/cache-identity'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../github-slice-test-harness'

import { runtimeOwnedRepoState } from '../../slices/store-test-helpers'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('does not reuse an old-runtime in-flight work-item fetch after a runtime switch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    type WorkItemsRpcResponse = {
      id: string
      ok: true
      result: WorkItemsEnvelope
      _meta: { runtimeId: string }
    }
    let resolveOldRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    let resolveNewRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    runtimeEnvironmentCall
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveOldRuntime = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveNewRuntime = resolve
          })
      )

    store.setState(runtimeOwnedRepoState('env-old', 'repo-old-runtime', '/server/repo'))
    const oldFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))

    store.setState(
      runtimeOwnedRepoState('env-new', 'repo-new-runtime', '/server/repo', {
        workItemsCache: {}
      })
    )
    const newFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2))

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-old',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-old-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-new',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-new-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })

    const newRuntimeItem = {
      type: 'issue',
      number: 2,
      title: 'New runtime item',
      url: 'https://example.test/new',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    resolveNewRuntime({
      id: 'rpc-new-work-items',
      ok: true,
      result: {
        items: [newRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'new-runtime' }
    })
    await expect(newFetch).resolves.toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])

    const oldRuntimeItem = {
      type: 'issue',
      number: 1,
      title: 'Old runtime item',
      url: 'https://example.test/old',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem
    resolveOldRuntime({
      id: 'rpc-old-work-items',
      ok: true,
      result: {
        items: [oldRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'old-runtime' }
    })
    await expect(oldFetch).resolves.toBeUndefined()
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey(
          'caller-repo-id',
          24,
          'is:open',
          'runtime:env-new',
          (() => {
            const repo = findRepoForGitHubOwner(store.getState(), 'caller-repo-id', '/server/repo')
            return repo && githubTaskBinding(repo)
          })()
        )
      ]?.data
    ).toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])
  })
})
