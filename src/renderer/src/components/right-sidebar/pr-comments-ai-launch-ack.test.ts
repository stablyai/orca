import { describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/types'
import type { PRCommentGroup } from '../../../../shared/pr-comment-groups'
import {
  acknowledgePRCommentsAfterAiLaunch,
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  checksPanelReviewStableKey,
  clearPendingPRCommentAiAck,
  getPRCommentGroupReplyTarget,
  getPRCommentGroupsNeedingReply,
  hasPRCommentGroupNeedingReply,
  PR_COMMENT_ACK_MAX_CONCURRENCY,
  resolvePRReviewReplyThreadId,
  setPendingPRCommentAiAck,
  takePendingPRCommentAiAck
} from './pr-comments-ai-launch-ack'
import type { PendingPRCommentAiAck } from './pr-comments-ai-launch-ack'
import {
  buildPRCommentBatchConversationReplyBody,
  buildPRCommentConversationReplyBody,
  formatPRCommentMentionHandle,
  PR_COMMENT_AI_FIXING_REPLY
} from './pr-comment-fixing-reply-body'

function comment(overrides: Partial<PRComment> = {}): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this.',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
    ...overrides
  }
}

type PRCommentThreadGroup = Extract<PRCommentGroup, { kind: 'thread' }>
type PRCommentStandaloneGroup = Extract<PRCommentGroup, { kind: 'standalone' }>

function openThread(threadId: string, id = 10): PRCommentThreadGroup {
  return {
    kind: 'thread',
    threadId,
    root: comment({ id, threadId, path: 'src/a.ts', isResolved: false }),
    replies: []
  }
}

function standalone(id = 20): PRCommentStandaloneGroup {
  return {
    kind: 'standalone',
    comment: comment({
      id,
      body: 'Overall looks good; one nit.',
      url: 'https://github.com/x/y/pull/1#issuecomment-9'
    })
  }
}

function codeRabbitReviewSummary(id = 30): PRCommentStandaloneGroup {
  return {
    kind: 'standalone',
    comment: comment({
      id,
      author: 'coderabbitai',
      isBot: true,
      body: '## Nitpick comments (2)\n\n...',
      url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
    })
  }
}

describe('canPostPRReviewThreadReply', () => {
  it('allows review-thread comments with threadId, path, or discussion_r url', () => {
    expect(canPostPRReviewThreadReply(comment({ id: 1, threadId: 'T1' }))).toBe(true)
    expect(canPostPRReviewThreadReply(comment({ id: 2, path: 'a.ts' }))).toBe(true)
    expect(
      canPostPRReviewThreadReply(
        comment({ id: 3, url: 'https://github.com/acme/widgets/pull/42#discussion_r99' })
      )
    ).toBe(true)
  })

  it('rejects conversation comments, review summaries, and invalid ids', () => {
    expect(
      canPostPRReviewThreadReply(
        comment({ id: 3, url: 'https://github.com/acme/widgets/pull/42#issuecomment-9' })
      )
    ).toBe(false)
    expect(
      canPostPRReviewThreadReply(
        comment({
          id: 4,
          url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
        })
      )
    ).toBe(false)
    expect(canPostPRReviewThreadReply(comment({ id: 0, threadId: 'T1' }))).toBe(false)
  })

  // Why: CodeRabbit review summaries can still carry path/threadId metadata; the
  // pullrequestreview anchor must win or the replies endpoint 404s.
  it('rejects review summaries even when thread metadata is present', () => {
    expect(
      canPostPRReviewThreadReply(
        comment({
          id: 5,
          threadId: 'T1',
          path: 'src/a.ts',
          url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
        })
      )
    ).toBe(false)
  })
})

describe('buildPRCommentConversationReplyBody', () => {
  it('strips the [bot] login suffix so the mention resolves', () => {
    expect(formatPRCommentMentionHandle('coderabbitai[bot]')).toBe('coderabbitai')
    expect(
      buildPRCommentConversationReplyBody('coderabbitai[bot]', PR_COMMENT_AI_FIXING_REPLY)
    ).toBe(`@coderabbitai ${PR_COMMENT_AI_FIXING_REPLY}`)
  })

  it('keeps human logins and drops the mention when the author is unknown', () => {
    expect(buildPRCommentConversationReplyBody('alice', 'Fixing.')).toBe('@alice Fixing.')
    expect(buildPRCommentConversationReplyBody(undefined, 'Fixing.')).toBe('Fixing.')
  })
})

describe('buildPRCommentBatchConversationReplyBody', () => {
  it('returns an empty body for an empty selection', () => {
    expect(buildPRCommentBatchConversationReplyBody([])).toBe('')
  })

  it('keeps the plain @-reply for a single target', () => {
    expect(
      buildPRCommentBatchConversationReplyBody([comment({ author: 'coderabbitai[bot]' })])
    ).toBe(`@coderabbitai ${PR_COMMENT_AI_FIXING_REPLY}`)
  })

  it('lists every target once with author, kind, and a short label', () => {
    const body = buildPRCommentBatchConversationReplyBody([
      comment({
        author: 'coderabbitai[bot]',
        body: '<!-- meta -->\n## Nitpick comments (2)\n\ndetails',
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
      }),
      comment({
        author: 'alice',
        body: 'Please rename this variable.',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-9'
      }),
      comment({ author: 'bob', body: 'Off by one.', path: 'src/a.ts', line: 12 })
    ])

    expect(body).toBe(
      [
        'Fixing:',
        '- @coderabbitai: review summary — Nitpick comments (2)',
        '- @alice: comment — Please rename this variable.',
        '- @bob: comment on src/a.ts:12 — Off by one.',
        '',
        'Will be in the next commit.'
      ].join('\n')
    )
  })

  it('truncates long bodies instead of quoting the whole comment', () => {
    const body = buildPRCommentBatchConversationReplyBody([
      comment({ author: 'alice', body: 'a'.repeat(200) }),
      comment({ author: 'bob', body: '' })
    ])

    expect(body).toContain(`- @alice: comment — ${'a'.repeat(71)}…`)
    expect(body).toContain('- @bob: comment\n')
  })
})

describe('getPRCommentGroupReplyTarget', () => {
  // Why: GitHub's replies endpoint keys off the top-level review comment id.
  it('uses the thread root even when later replies exist', () => {
    const group: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T1',
      root: comment({ id: 10, threadId: 'T1', path: 'a.ts' }),
      replies: [
        comment({ id: 11, threadId: 'T1', path: 'a.ts', body: 'first' }),
        comment({ id: 12, threadId: 'T1', path: 'a.ts', body: 'latest' })
      ]
    }
    expect(getPRCommentGroupReplyTarget(group).id).toBe(10)
  })

  it('falls back to the root when there are no replies', () => {
    const group = openThread('T1', 10)
    expect(getPRCommentGroupReplyTarget(group).id).toBe(10)
  })
})

describe('attachPRReviewReplyParent', () => {
  it('fills missing thread metadata from the parent', () => {
    const parent = comment({
      id: 10,
      threadId: 'T1',
      path: 'src/a.ts',
      line: 4,
      isResolved: false
    })
    const reply = comment({ id: 99, body: 'Fixing.' })
    expect(attachPRReviewReplyParent(reply, parent)).toMatchObject({
      id: 99,
      body: 'Fixing.',
      threadId: 'T1',
      path: 'src/a.ts',
      line: 4,
      isResolved: false
    })
  })

  it('does not overwrite explicit reply metadata', () => {
    const parent = comment({ id: 10, threadId: 'T1', path: 'src/a.ts', line: 4 })
    const reply = comment({ id: 99, threadId: 'T2', path: 'src/b.ts', line: 9 })
    expect(attachPRReviewReplyParent(reply, parent)).toMatchObject({
      threadId: 'T2',
      path: 'src/b.ts',
      line: 9
    })
  })
})
describe('resolvePRReviewReplyThreadId', () => {
  it('prefers the parent threadId', () => {
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 1, threadId: 'T1', path: 'a.ts' }),
        existingComments: []
      })
    ).toBe('T1')
  })

  it('recovers threadId from existing comments by id or path/line', () => {
    const existing = [
      comment({ id: 1, threadId: 'T_path', path: 'src/a.ts', line: 3 }),
      comment({ id: 2, threadId: 'T_id', path: 'src/b.ts', line: 9 })
    ]
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 2, path: 'src/b.ts', line: 9 }),
        existingComments: existing
      })
    ).toBe('T_id')
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 50, path: 'src/a.ts', line: 3 }),
        existingComments: existing
      })
    ).toBe('T_path')
  })

  it('refuses a path-only match when the file holds several threads', () => {
    const existing = [
      comment({ id: 1, threadId: 'T_one', path: 'src/a.ts', line: 3 }),
      comment({ id: 2, threadId: 'T_two', path: 'src/a.ts', line: 40 })
    ]
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 50, path: 'src/a.ts', line: undefined }),
        existingComments: existing
      })
    ).toBeUndefined()
    // A line-scoped parent still matches its own thread.
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 50, path: 'src/a.ts', line: 40 }),
        existingComments: existing
      })
    ).toBe('T_two')
  })
})

describe('checksPanelReviewStableKey', () => {
  it('drops the trailing headSha segment', () => {
    expect(checksPanelReviewStableKey('repo::main::owner/repo::12::abc123')).toBe(
      'repo::main::owner/repo::12'
    )
  })

  it('passes through a key with no separator', () => {
    expect(checksPanelReviewStableKey('solo')).toBe('solo')
  })
})

describe('acknowledgePRCommentsAfterAiLaunch', () => {
  // Why: the reported bug — resolving is the acknowledgement, so a resolvable thread must
  // never also get a "Fixing." reply on top of a thread that visibly collapsed.
  it('resolves host-resolvable threads without replying to them', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)
    const replyInThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1'), openThread('T2', 11)],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 2, replied: 0, skipped: 0, failed: 0 })
    expect(resolveThread.mock.calls.map(([threadId]) => threadId)).toEqual(['T1', 'T2'])
    expect(replyInThread).not.toHaveBeenCalled()
    expect(replyAsConversation).not.toHaveBeenCalled()
  })

  // Why: a failed resolve leaves the thread open on the host, so the toast must not claim success.
  it('counts a failed resolve instead of falling back to a reply', async () => {
    const replyInThread = vi.fn()

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        resolveThread: vi.fn().mockResolvedValue(false),
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
    expect(replyInThread).not.toHaveBeenCalled()
  })

  // Why: GitLab reaches the ack with canReply false, so a failed resolve has no reply to fall
  // back on and must still be counted.
  it('counts a failed resolve on a provider that cannot reply', async () => {
    const replyInThread = vi.fn()
    const replyAsConversation = vi.fn()

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        resolveThread: vi.fn().mockResolvedValue(false),
        canReply: false,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
    expect(replyInThread).not.toHaveBeenCalled()
    expect(replyAsConversation).not.toHaveBeenCalled()
  })

  // Why: resolve used to be gated on panel/live-comment state and got silently skipped when
  // a slow agent launch outlived either; the snapshotted threadId must always be attempted.
  it('resolves every selected thread with no live-state gate', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1'), openThread('T2', 11), openThread('T3', 12)],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(resolveThread).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ resolved: 3, replied: 0, skipped: 0, failed: 0 })
  })

  // Why: GitLab MRs reach the ack with canReply false; resolve is the whole acknowledgement there.
  it('resolves threads on providers that cannot reply', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        resolveThread,
        canReply: false,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 1, replied: 0, skipped: 0, failed: 0 })
    expect(resolveThread).toHaveBeenCalledWith('T1')
  })

  // Why: a summary thread GitHub *can* resolve is acked by resolving, even though its
  // pullrequestreview anchor rules out a nested reply.
  it('resolves a review-summary thread instead of batching it into a conversation post', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn()
    const summaryThread: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T_summary',
      root: comment({
        id: 30,
        threadId: 'T_summary',
        isResolved: false,
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
      }),
      replies: []
    }

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [summaryThread],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 1, replied: 0, skipped: 0, failed: 0 })
    expect(resolveThread).toHaveBeenCalledWith('T_summary')
    expect(replyAsConversation).not.toHaveBeenCalled()
  })

  // Why: an already-resolved thread has nothing left to close, so it falls back to a reply.
  it('replies in-thread when the thread is already resolved', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const resolveThread = vi.fn()
    const group: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T1',
      root: comment({ id: 10, threadId: 'T1', path: 'a.ts', isResolved: true }),
      replies: []
    }

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(resolveThread).not.toHaveBeenCalled()
    expect(replyInThread).toHaveBeenCalledWith(group.root, PR_COMMENT_AI_FIXING_REPLY)
  })

  // Why: GitHub's replies endpoint keys off the top-level review comment id; replying to the
  // newest reply 404s.
  it('replies to the thread root, not the newest reply, on an already-resolved thread', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const root = comment({ id: 10, threadId: 'T1', path: 'a.ts', isResolved: true })
    const group: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T1',
      root,
      replies: [
        comment({ id: 11, threadId: 'T1', path: 'a.ts', body: 'first' }),
        comment({ id: 12, threadId: 'T1', path: 'a.ts', body: 'latest' })
      ]
    }

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledWith(root, PR_COMMENT_AI_FIXING_REPLY)
  })

  it('posts a conversation @-reply for standalone conversation comments', async () => {
    const replyAsConversation = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [standalone(42)],
      deps: {
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyAsConversation).toHaveBeenCalledTimes(1)
    expect(replyAsConversation).toHaveBeenCalledWith(`@alice ${PR_COMMENT_AI_FIXING_REPLY}`)
  })

  it('posts no conversation comment when nothing in the selection needs one', async () => {
    const replyAsConversation = vi.fn()

    await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1'), openThread('T2', 11)],
      deps: {
        resolveThread: vi.fn().mockResolvedValue(true),
        canReply: true,
        replyInThread: vi.fn().mockResolvedValue(true),
        replyAsConversation
      }
    })

    expect(replyAsConversation).not.toHaveBeenCalled()
  })

  it('posts a conversation @-reply for CodeRabbit review summaries', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [codeRabbitReviewSummary(77)],
      deps: {
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyInThread).not.toHaveBeenCalled()
    expect(replyAsConversation).toHaveBeenCalledWith(`@coderabbitai ${PR_COMMENT_AI_FIXING_REPLY}`)
  })

  // Why: N selected summaries used to produce N near-identical "Fixing." conversation
  // comments; one combined post covers the whole set.
  it('combines every unresolvable review summary into one conversation comment', async () => {
    const replyAsConversation = vi.fn().mockResolvedValue(true)
    const resolveThread = vi.fn()

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [codeRabbitReviewSummary(30), codeRabbitReviewSummary(31), standalone(32)],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation
      }
    })

    // Why: one host POST, so replied counts 1 — not one per selected comment.
    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyAsConversation).toHaveBeenCalledTimes(1)
    expect(replyAsConversation.mock.calls[0]?.[0]).toBe(
      [
        'Fixing:',
        '- @coderabbitai: review summary — Nitpick comments (2)',
        '- @coderabbitai: review summary — Nitpick comments (2)',
        '- @alice: comment — Overall looks good; one nit.',
        '',
        'Will be in the next commit.'
      ].join('\n')
    )
    expect(resolveThread).not.toHaveBeenCalled()
  })

  it('resolves threads and batches the conversation half in a single selection', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)
    const replyInThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [
        openThread('T1', 10),
        codeRabbitReviewSummary(30),
        openThread('T2', 11),
        standalone(31)
      ],
      deps: {
        resolveThread,
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 2, replied: 1, skipped: 0, failed: 0 })
    expect(replyInThread).not.toHaveBeenCalled()
    expect(replyAsConversation).toHaveBeenCalledTimes(1)
    expect(replyAsConversation.mock.calls[0]?.[0]).toContain('Fixing:')
  })

  // Why: a path-only review comment with no thread metadata still nests a reply.
  it('replies in-thread for an unresolvable comment that supports nesting', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const target = comment({ id: 10, path: 'src/a.ts', line: 12 })

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [{ kind: 'standalone', comment: target }],
      deps: {
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledWith(target, PR_COMMENT_AI_FIXING_REPLY)
  })

  it('counts a failed conversation reply instead of silently reporting success', async () => {
    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [codeRabbitReviewSummary(30)],
      deps: {
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn().mockResolvedValue(false)
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
  })

  it('skips an unresolvable comment when the provider cannot reply', async () => {
    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [standalone()],
      deps: {
        resolveThread: vi.fn(),
        canReply: false,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 1, failed: 0 })
  })

  it('keeps a durable pending payload across take', () => {
    const payload: PendingPRCommentAiAck = {
      reviewContextKey: 'repo::main::owner/repo::12::abc',
      provider: 'github',
      selectedGroups: [openThread('T1')]
    }
    clearPendingPRCommentAiAck()
    setPendingPRCommentAiAck(payload)
    expect(takePendingPRCommentAiAck()).toBe(payload)
    expect(takePendingPRCommentAiAck()).toBeNull()
  })

  // Why: the ack resolves after delivery, by which point the panel may show another review —
  // the host target must ride along in the payload, not be re-read from live state.
  it('carries the snapshotted GitLab target through take', () => {
    const payload: PendingPRCommentAiAck = {
      reviewContextKey: 'repo::main::gitlab::7::abc',
      provider: 'gitlab',
      selectedGroups: [openThread('D1')],
      gitlabTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', iid: 7 }
    }
    clearPendingPRCommentAiAck()
    setPendingPRCommentAiAck(payload)
    expect(takePendingPRCommentAiAck()?.gitlabTarget).toEqual({
      repoPath: '/repos/widgets',
      repoId: 'repo-1',
      iid: 7
    })
  })

  it('runs groups with bounded concurrency', async () => {
    const groups = Array.from({ length: 9 }, (_, index) => openThread(`T${index}`, 100 + index))
    let inFlight = 0
    let peakInFlight = 0

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups,
      deps: {
        resolveThread: async () => {
          inFlight += 1
          peakInFlight = Math.max(peakInFlight, inFlight)
          await Promise.resolve()
          inFlight -= 1
          return true
        },
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 9, replied: 0, skipped: 0, failed: 0 })
    expect(peakInFlight).toBeGreaterThan(1)
    expect(peakInFlight).toBeLessThanOrEqual(PR_COMMENT_ACK_MAX_CONCURRENCY)
  })
})

describe('getPRCommentGroupsNeedingReply', () => {
  it('keeps only the groups the host cannot close for us', () => {
    const summary = codeRabbitReviewSummary(30)
    const conversation = standalone(31)
    const resolvedThread: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T_done',
      root: comment({ id: 12, threadId: 'T_done', isResolved: true }),
      replies: []
    }

    expect(
      getPRCommentGroupsNeedingReply([
        openThread('T1'),
        summary,
        conversation,
        resolvedThread,
        openThread('T2', 11)
      ])
    ).toEqual([summary, conversation, resolvedThread])
  })
})

describe('hasPRCommentGroupNeedingReply', () => {
  it('matches the filtered list without materializing it', () => {
    expect(hasPRCommentGroupNeedingReply([openThread('T1'), openThread('T2', 11)])).toBe(false)
    expect(hasPRCommentGroupNeedingReply([openThread('T1'), standalone(31)])).toBe(true)
    expect(hasPRCommentGroupNeedingReply([])).toBe(false)
  })
})
