import { describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/types'
import type { PRCommentGroup } from '@/lib/pr-comment-groups'
import {
  acknowledgePRCommentsAfterAiLaunch,
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  checksPanelReviewStableKey,
  clearPendingPRCommentAiAck,
  getPRCommentGroupReplyTarget,
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
  it('replies in-thread and resolves host-resolvable threads', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)
    const replyInThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn().mockResolvedValue(true)
    const group = openThread('T1')

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group, openThread('T2', 11)],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread,
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 2, replied: 2, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledTimes(2)
    expect(replyInThread).toHaveBeenCalledWith(group.root, PR_COMMENT_AI_FIXING_REPLY)
    expect(replyAsConversation).not.toHaveBeenCalled()
    expect(resolveThread).toHaveBeenCalledTimes(2)
  })

  // Why: on GitHub canReply is true; a failed resolve still leaves the thread open and
  // must count as failed or the success toast lies.
  it('still replies in-thread when resolve fails, and counts the failed resolve', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const group = openThread('T1')

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: vi.fn().mockResolvedValue(false),
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 1 })
    expect(replyInThread).toHaveBeenCalledWith(group.root, PR_COMMENT_AI_FIXING_REPLY)
  })

  it('posts a conversation @-reply for standalone conversation comments', async () => {
    const replyAsConversation = vi.fn().mockResolvedValue(true)
    const group = standalone(42)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
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
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
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
    const group = codeRabbitReviewSummary(77)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
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

  // Why: the reported bug — N selected summaries used to produce N near-identical
  // "Fixing." conversation comments; one combined post covers the whole set.
  it('combines every unresolvable review summary into one conversation comment', async () => {
    const replyAsConversation = vi.fn().mockResolvedValue(true)
    const resolveThread = vi.fn()

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [codeRabbitReviewSummary(30), codeRabbitReviewSummary(31), standalone(32)],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => false,
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

  it('mixes in-thread and conversation replies in a single selection', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const replyAsConversation = vi.fn().mockResolvedValue(true)
    const thread = openThread('T1', 10)
    const summary = codeRabbitReviewSummary(30)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [thread, summary],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: vi.fn().mockResolvedValue(true),
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 1, replied: 2, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledWith(thread.root, PR_COMMENT_AI_FIXING_REPLY)
    expect(replyAsConversation).toHaveBeenCalledWith(`@coderabbitai ${PR_COMMENT_AI_FIXING_REPLY}`)
  })

  // Why: nestable threads keep one reply each; only the conversation half is batched.
  it('replies once per thread and once for the whole conversation set', async () => {
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
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: vi.fn().mockResolvedValue(true),
        canReply: true,
        replyInThread,
        replyAsConversation
      }
    })

    expect(result).toEqual({ resolved: 2, replied: 3, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledTimes(2)
    expect(replyAsConversation).toHaveBeenCalledTimes(1)
    expect(replyAsConversation.mock.calls[0]?.[0]).toContain('Fixing:')
  })

  it('counts a failed conversation reply instead of silently reporting success', async () => {
    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [codeRabbitReviewSummary(30)],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => false,
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn().mockResolvedValue(false)
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
  })

  it('replies to the thread root in a multi-comment thread', async () => {
    const replyInThread = vi.fn().mockResolvedValue(true)
    const group: PRCommentGroup = {
      kind: 'thread',
      threadId: 'T1',
      root: comment({ id: 10, threadId: 'T1', path: 'a.ts', isResolved: false }),
      replies: [comment({ id: 11, threadId: 'T1', path: 'a.ts', body: 'prior reply' })]
    }

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [group],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => false,
        resolveThread: vi.fn(),
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 0, failed: 0 })
    expect(replyInThread).toHaveBeenCalledWith(group.root, PR_COMMENT_AI_FIXING_REPLY)
  })

  it('skips when reply is unavailable and resolve cannot run', async () => {
    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [standalone()],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: vi.fn(),
        canReply: false,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 1, failed: 0 })
  })

  it('counts a failure when resolve fails and reply is unavailable', async () => {
    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: vi.fn().mockResolvedValue(false),
        canReply: false,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
  })

  it('keeps a durable pending payload across take', () => {
    const payload: PendingPRCommentAiAck = {
      reviewContextKey: 'repo::main::owner/repo::12::abc',
      provider: 'github',
      selectedThreadIds: ['T1'],
      selectedGroups: [openThread('T1')]
    }
    clearPendingPRCommentAiAck()
    setPendingPRCommentAiAck(payload)
    expect(takePendingPRCommentAiAck()).toBe(payload)
    expect(takePendingPRCommentAiAck()).toBeNull()
  })

  it('still posts all replies when the review context becomes stale mid-loop', async () => {
    let live = true
    const replyInThread = vi.fn().mockImplementation(async () => {
      live = false
      return true
    })
    const resolveThread = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1'), openThread('T2', 11), openThread('T3', 12)],
      deps: {
        isStillCurrent: () => live,
        isThreadStillResolvable: () => true,
        resolveThread,
        canReply: true,
        replyInThread,
        replyAsConversation: vi.fn()
      }
    })

    // Why: replies must not depend on checks-panel key stability; resolve stops after context
    // goes stale, and each skipped resolve is reported rather than silently counted as success.
    expect(replyInThread).toHaveBeenCalledTimes(3)
    expect(resolveThread).toHaveBeenCalledTimes(0)
    expect(result).toEqual({ resolved: 0, replied: 3, skipped: 3, failed: 0 })
  })

  // Why: resolving after a failed reply closes the thread with no ack at all.
  it('leaves a thread open when its fixing reply failed', async () => {
    const resolveThread = vi.fn().mockResolvedValue(true)

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread,
        canReply: true,
        replyInThread: vi.fn().mockResolvedValue(false),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
    expect(resolveThread).not.toHaveBeenCalled()
  })

  it('does not resolve batched conversation groups when the combined post failed', async () => {
    const resolveThread = vi.fn()
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
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread,
        canReply: true,
        replyInThread: vi.fn(),
        replyAsConversation: vi.fn().mockResolvedValue(false)
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 0, skipped: 0, failed: 1 })
    expect(resolveThread).not.toHaveBeenCalled()
  })

  it('reports a resolvable thread as skipped when the panel context moved', async () => {
    const resolveThread = vi.fn()

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups: [openThread('T1')],
      deps: {
        isStillCurrent: () => false,
        isThreadStillResolvable: () => true,
        resolveThread,
        canReply: true,
        replyInThread: vi.fn().mockResolvedValue(true),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 0, replied: 1, skipped: 1, failed: 0 })
    expect(resolveThread).not.toHaveBeenCalled()
  })

  it('runs groups with bounded concurrency, replying before resolving in each group', async () => {
    const groups = Array.from({ length: 9 }, (_, index) => openThread(`T${index}`, 100 + index))
    const order: string[] = []
    let inFlight = 0
    let peakInFlight = 0

    const track = async <T>(label: string, value: T): Promise<T> => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      order.push(label)
      await Promise.resolve()
      inFlight -= 1
      return value
    }

    const result = await acknowledgePRCommentsAfterAiLaunch({
      groups,
      deps: {
        isStillCurrent: () => true,
        isThreadStillResolvable: () => true,
        resolveThread: (threadId) => track(`resolve:${threadId}`, true),
        canReply: true,
        replyInThread: (comment) => track(`reply:${comment.threadId}`, true),
        replyAsConversation: vi.fn()
      }
    })

    expect(result).toEqual({ resolved: 9, replied: 9, skipped: 0, failed: 0 })
    expect(peakInFlight).toBeGreaterThan(1)
    expect(peakInFlight).toBeLessThanOrEqual(PR_COMMENT_ACK_MAX_CONCURRENCY)
    for (const group of groups) {
      expect(order.indexOf(`reply:${group.threadId}`)).toBeLessThan(
        order.indexOf(`resolve:${group.threadId}`)
      )
    }
  })
})
