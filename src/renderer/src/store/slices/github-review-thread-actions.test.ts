import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { AppState } from '../types'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from '../github/cache-identity'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

const repoPath = '/repo'
const repoId = 'repo-id'
const threadId = 'thread-1'

function makeComments(isResolved = false): PRComment[] {
  return [
    {
      id: 1,
      author: 'octocat',
      authorAvatarUrl: '',
      body: 'review',
      createdAt: '2026-08-23T00:00:00Z',
      url: '',
      threadId,
      isResolved
    }
  ]
}

function installLocalComments(store: ReturnType<typeof createTestStore>): string {
  const cacheKey = sourceScopedRepoCacheKey(repoPath, repoId, prCommentsCacheSuffix(12))
  store.setState({
    repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
    commentsCache: { [cacheKey]: { data: makeComments(), fetchedAt: 1 } }
  } as unknown as Partial<AppState>)
  return cacheKey
}

describe('createGitHubSlice.resolveReviewThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('optimistically resolves and routes through the repository runtime', async () => {
    const store = createTestStore()
    const settings = { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(12),
      settings,
      null,
      'runtime:env-1',
      undefined,
      true
    )
    store.setState({
      settings,
      repos: [
        {
          id: repoId,
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ],
      commentsCache: { [cacheKey]: { data: makeComments(), fetchedAt: 1 } }
    } as unknown as Partial<AppState>)
    const runtimeResult = Promise.withResolvers<{
      id: string
      ok: true
      result: boolean
      _meta: { runtimeId: string }
    }>()
    runtimeEnvironmentCall.mockReturnValueOnce(runtimeResult.promise)

    const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, {
      repoId
    })
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
    runtimeResult.resolve({
      id: 'rpc-thread',
      ok: true,
      result: true,
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(pending).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.resolveReviewThread',
      params: { repo: repoId, threadId, resolve: true, prRepo: null },
      timeoutMs: 30_000
    })
    expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
  })

  it('rolls back the captured comment array when GitHub returns false', async () => {
    const store = createTestStore()
    const cacheKey = installLocalComments(store)
    const result = Promise.withResolvers<boolean>()
    mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)

    const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, { repoId })
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
    result.resolve(false)

    await expect(pending).resolves.toBe(false)
    expect(store.getState().commentsCache[cacheKey]?.data).toEqual(makeComments())
  })

  it('swallows a thrown transport error and rolls back the captured comment array', async () => {
    const store = createTestStore()
    const cacheKey = installLocalComments(store)
    mockApi.gh.resolveReviewThread.mockRejectedValueOnce(new Error('offline'))

    await expect(
      store.getState().resolveReviewThread(repoPath, 12, threadId, true, { repoId })
    ).resolves.toBe(false)
    expect(store.getState().commentsCache[cacheKey]?.data).toEqual(makeComments())
  })
})
