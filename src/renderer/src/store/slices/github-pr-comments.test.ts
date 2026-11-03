import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prCommentsCacheSuffix } from '../github/cache-identity'
import '../github/pr-comment-cache'
import type { PRComment } from '../../../../shared/github/comment-types'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'
import type { AppState } from '../types'
import '../../../../shared/task-source-context'

describe('createGitHubSlice.fetchPRComments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prComments.mockResolvedValue([])
  })

  it.each([false, true])(
    'an explicit refresh replaces a pre-click read and keeps comments posted during either (click fails: %s)',
    async (clickFails) => {
      const store = createTestStore()
      const comment = (id: number, body: string): PRComment => ({
        id,
        author: 'octocat',
        authorAvatarUrl: '',
        body,
        createdAt: `2026-08-23T00:00:0${id}Z`,
        url: ''
      })
      const old = Promise.withResolvers<PRComment[]>()
      const fresh = Promise.withResolvers<PRComment[]>()
      mockApi.gh.prComments.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      mockApi.gh.addIssueComment
        .mockResolvedValueOnce({ ok: true, comment: comment(2, 'posted before') })
        .mockResolvedValueOnce({ ok: true, comment: comment(3, 'posted during') })
      const options = { repoId: 'repo-1' }
      const before = store.getState().fetchPRComments('/repo/one', 12, options)
      let click: Promise<PRComment[]> = Promise.resolve([])
      try {
        await store.getState().addPRConversationComment('/repo/one', 12, 'posted before', options)
        click = store
          .getState()
          .fetchPRComments('/repo/one', 12, { ...options, force: true, userRefresh: true })
        await store.getState().addPRConversationComment('/repo/one', 12, 'posted during', options)
        expect(mockApi.gh.prComments).toHaveBeenCalledTimes(2)
        expect(mockApi.gh.prComments).toHaveBeenLastCalledWith(
          expect.objectContaining({ noCache: true })
        )
        if (clickFails) {
          // The pre-click read's answer is still newer than the cache, so it lands instead.
          fresh.reject(new Error('lost reply'))
          old.resolve([comment(1, 'old')])
        } else {
          fresh.resolve([comment(1, 'new')])
        }
        const shown = await click
        expect(shown.map((entry) => entry.body).sort()).toEqual([
          clickFails ? 'old' : 'new',
          'posted before',
          'posted during'
        ])
        old.resolve([comment(1, 'old')])
        await expect(before).resolves.toEqual(shown)
        expect(Object.values(store.getState().commentsCache).map((entry) => entry.data)).toEqual([
          shown
        ])
      } finally {
        old.resolve([])
        fresh.resolve([])
        await Promise.all([before, click])
      }
    }
  )

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
})
