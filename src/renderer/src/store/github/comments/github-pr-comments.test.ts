import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'
import type { AppState } from '../../types'

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
