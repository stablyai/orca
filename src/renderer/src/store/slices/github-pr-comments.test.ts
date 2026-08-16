import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergePRCommentIntoList, prCommentsCacheSuffix } from './github'
import {
  createTestStore,
  githubSourceContext,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

describe('createGitHubSlice.fetchPRComments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prComments.mockResolvedValue([])
  })

  it('keys PR comments by normalized PR repo identity', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    mockApi.gh.prComments
      .mockResolvedValueOnce([
        { id: 1, author: 'upstream', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
      ])
      .mockResolvedValueOnce([
        { id: 2, author: 'fork', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
      ])

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })
    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Fork', repo: 'Widgets' }
    })

    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].author
    ).toBe('upstream')
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::fork/widgets::12`]?.data?.[0].author
    ).toBe('fork')
    expect(mockApi.gh.prComments).toHaveBeenNthCalledWith(1, {
      repoPath,
      repoId,
      prNumber: 12,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      noCache: true
    })
  })

  it('stores runtime PR comments under runtime-scoped cache keys', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-comments',
      ok: true,
      result: [{ id: 1, author: 'remote', authorAvatarUrl: '', body: '', createdAt: '', url: '' }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: repoId,
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prComments',
      params: {
        repo: repoId,
        prNumber: 12,
        prRepo: { owner: 'Acme', repo: 'Widgets' },
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
        ?.data?.[0].author
    ).toBe('remote')
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
  })

  it('keeps known local repo comments on local cache keys when a runtime is focused', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    mockApi.gh.prComments.mockResolvedValueOnce([
      { id: 1, author: 'local', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
    ])

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.prComments).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      noCache: true,
      sourceContext: undefined
    })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].author
    ).toBe('local')
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
  })

  it('routes explicit source-context PR comments through the source runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-source-comments',
      ok: true,
      result: [{ id: 1, author: 'source', authorAvatarUrl: '', body: '', createdAt: '', url: '' }],
      _meta: { runtimeId: 'source-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'caller-repo-id'
    const sourceContext = githubSourceContext('runtime:source-runtime', 'runtime-repo-id')
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      sourceContext,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.prComments',
      params: {
        repo: 'runtime-repo-id',
        prNumber: 12,
        prRepo: { owner: 'Acme', repo: 'Widgets' },
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[
        `${getTaskSourceCacheScope(sourceContext)}::${repoId}::pr-comments::acme/widgets::12`
      ]?.data?.[0].author
    ).toBe('source')
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
  })

  it('bounds PR comment cache entries across many repos', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.prComments.mockResolvedValue([])

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchPRComments(`/repo/${i}`, 12, {
          force: true,
          repoId: `repo-${i}`
        })
      }

      const cache = store.getState().commentsCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(cache[`repo-0::${prCommentsCacheSuffix(12)}`]).toBeUndefined()
      expect(cache[`repo-500::${prCommentsCacheSuffix(12)}`]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves cached checks when the checks IPC fails', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const checksCacheKey = `${repoPath}::pr-checks::12`
    const cachedChecks = [
      { name: 'build', status: 'completed', conclusion: 'failure', url: null } as const
    ]

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: cachedChecks,
          fetchedAt: 1,
          headSha: 'abc123head'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.prChecks.mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      store.getState().fetchPRChecks(repoPath, 12, branch, 'abc123head', null, { force: true })
    ).resolves.toEqual(cachedChecks)

    expect(store.getState().checksCache[checksCacheKey]?.data).toEqual(cachedChecks)
    expect(store.getState().checksCache[checksCacheKey]?.fetchedAt).toBe(1)
  })

  it('does not return cached checks for a different requested head SHA after IPC failure', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const checksCacheKey = `${repoPath}::pr-checks::12`
    const oldHeadChecks = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null } as const
    ]

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: oldHeadChecks,
          fetchedAt: 1,
          headSha: 'old-head'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.prChecks.mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      store.getState().fetchPRChecks(repoPath, 12, branch, 'new-head', null, { force: true })
    ).resolves.toEqual([])

    expect(store.getState().checksCache[checksCacheKey]?.data).toEqual(oldHeadChecks)
    expect(store.getState().checksCache[checksCacheKey]?.headSha).toBe('old-head')
  })
})

describe('createGitHubSlice PR comment mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.addIssueComment.mockResolvedValue({
      ok: true,
      comment: {
        id: 10,
        author: 'me',
        authorAvatarUrl: '',
        body: 'done',
        createdAt: '2026-03-28T00:00:00Z',
        url: ''
      }
    })
    mockApi.gh.addPRReviewCommentReply.mockResolvedValue({
      ok: true,
      comment: {
        id: 11,
        author: 'me',
        authorAvatarUrl: '',
        body: 'reply',
        createdAt: '2026-03-28T00:01:00Z',
        url: ''
      }
    })
    mockApi.gh.setPRCommentReaction.mockResolvedValue(true)
  })

  it('deduplicates merged PR comments and preserves existing thread metadata', () => {
    expect(
      mergePRCommentIntoList(
        [
          {
            id: 4,
            author: 'reviewer',
            authorAvatarUrl: '',
            body: 'old',
            createdAt: '2026-03-28T00:00:00Z',
            url: '',
            threadId: 'PRRT_1',
            path: 'src/a.ts',
            line: 12,
            isResolved: false
          }
        ],
        {
          id: 4,
          author: 'reviewer',
          authorAvatarUrl: '',
          body: 'new',
          createdAt: '2026-03-28T00:02:00Z',
          url: ''
        }
      )
    ).toEqual([
      {
        id: 4,
        author: 'reviewer',
        authorAvatarUrl: '',
        body: 'new',
        createdAt: '2026-03-28T00:02:00Z',
        url: '',
        threadId: 'PRRT_1',
        path: 'src/a.ts',
        line: 12,
        isResolved: false
      }
    ])
  })

  it('posts top-level PR comments with the visible PR repo and pr invalidation type', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith({
      repoPath,
      repoId,
      number: 12,
      body: 'done',
      type: 'pr',
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].body
    ).toBe('done')
  })

  it('posts top-level PR comments with explicit local source context', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const sourceContext = githubSourceContext('local', repoId)
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      sourceContext,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith({
      repoPath,
      repoId,
      number: 12,
      body: 'done',
      type: 'pr',
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      sourceContext
    })
    expect(
      store.getState().commentsCache[
        `${getTaskSourceCacheScope(sourceContext)}::${repoId}::pr-comments::acme/widgets::12`
      ]?.data?.[0].body
    ).toBe('done')
  })

  it('routes runtime PR review replies with prRepo and merges returned thread metadata', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-pr-reply',
      ok: true,
      result: {
        ok: true,
        comment: {
          id: 12,
          author: 'me',
          authorAvatarUrl: '',
          body: 'reply',
          createdAt: '2026-03-28T00:02:00Z',
          url: ''
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: repoId,
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await store.getState().addPRReviewCommentReply(repoPath, 12, 99, 'reply', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      threadId: 'PRRT_1',
      path: 'src/a.ts',
      line: 8
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.addPRReviewCommentReply',
      params: {
        repo: repoId,
        prNumber: 12,
        commentId: 99,
        body: 'reply',
        threadId: 'PRRT_1',
        path: 'src/a.ts',
        line: 8,
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
        ?.data?.[0]
    ).toMatchObject({ body: 'reply', threadId: 'PRRT_1', path: 'src/a.ts', line: 8 })
  })

  it('updates cached reactions through local GitHub IPC', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      commentsCache: {
        [cacheKey]: {
          data: [
            {
              id: 10,
              reactionSubjectId: 'IC_10',
              author: 'reviewer',
              authorAvatarUrl: '',
              body: 'Nice',
              createdAt: '2026-03-28T00:00:00Z',
              url: ''
            }
          ],
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    await store.getState().setPRCommentReaction(repoPath, 12, 'IC_10', 'heart', true, {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(mockApi.gh.setPRCommentReaction).toHaveBeenCalledWith({
      repoPath,
      repoId,
      reactionSubjectId: 'IC_10',
      content: 'heart',
      reacted: true,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      sourceContext: undefined
    })
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].reactions).toEqual([
      { content: 'heart', count: 1, viewerHasReacted: true }
    ])
  })

  it('rolls back an optimistic reaction when GitHub rejects it', async () => {
    let resolveReaction!: (ok: boolean) => void
    mockApi.gh.setPRCommentReaction.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveReaction = resolve))
    )
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      commentsCache: {
        [cacheKey]: {
          data: [
            {
              id: 10,
              reactionSubjectId: 'IC_10',
              author: 'reviewer',
              authorAvatarUrl: '',
              body: 'Nice',
              createdAt: '2026-03-28T00:00:00Z',
              url: '',
              reactions: [{ content: 'heart', count: 2, viewerHasReacted: false }]
            }
          ],
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    const pending = store.getState().setPRCommentReaction(repoPath, 12, 'IC_10', 'heart', true, {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })
    const optimisticEntry = store.getState().commentsCache[cacheKey]
    store.setState({
      commentsCache: {
        ...store.getState().commentsCache,
        [cacheKey]: {
          ...optimisticEntry,
          data: (optimisticEntry?.data ?? []).map((comment) => ({
            ...comment,
            reactions: [
              ...(comment.reactions ?? []),
              { content: 'eyes' as const, count: 1, viewerHasReacted: false }
            ]
          }))
        }
      }
    })
    resolveReaction(false)
    const ok = await pending

    expect(ok).toBe(false)
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].reactions).toEqual([
      { content: 'heart', count: 2, viewerHasReacted: false },
      { content: 'eyes', count: 1, viewerHasReacted: false }
    ])
  })

  it('routes reaction mutations through the workspace runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-pr-reaction',
      ok: true,
      result: true,
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: repoId,
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await store.getState().setPRCommentReaction(repoPath, 12, 'PRRC_10', 'rocket', true, {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.setPRCommentReaction',
      params: {
        repo: repoId,
        reactionSubjectId: 'PRRC_10',
        content: 'rocket',
        reacted: true,
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      timeoutMs: 30_000
    })
    expect(mockApi.gh.setPRCommentReaction).not.toHaveBeenCalled()
  })

  it('does not mutate the PR comments cache when GitHub omits the comment payload', async () => {
    mockApi.gh.addIssueComment.mockResolvedValueOnce({ ok: true })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(result).toEqual({ ok: false, error: 'GitHub did not return the new comment.' })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
  })
})
