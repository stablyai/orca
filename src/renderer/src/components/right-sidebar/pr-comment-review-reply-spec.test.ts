import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { MAX_REVIEW_REPLY_TARGETS } from '../../../../shared/agent-session-review-reply'
import { buildPRCommentReviewReply } from './pr-comment-review-reply-spec'
import { PR_COMMENT_AI_FIXING_REPLY } from './pr-comment-fixing-reply-body'
import type { PendingPRCommentAiAck } from './pr-comments-ai-launch-ack'

function comment(overrides: Partial<PRComment>): PRComment {
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

const TARGET = { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 42 }

/** An open thread to resolve, an outdated thread with a path only, and a conversation comment. */
function github(): PendingPRCommentAiAck {
  return {
    reviewContextKey: 'repo-1::42::sha-1',
    provider: 'github',
    selectedGroups: [
      {
        kind: 'thread',
        threadId: 'T1',
        root: comment({ id: 10, threadId: 'T1', path: 'src/a.ts', isResolved: false }),
        replies: []
      },
      { kind: 'standalone', comment: comment({ id: 11, path: 'src/b.ts', line: 4 }) },
      {
        kind: 'standalone',
        comment: comment({ id: 20, url: 'https://github.com/acme/widgets/pull/42#issuecomment-9' })
      }
    ],
    githubTarget: { ...TARGET, prRepo: { owner: 'acme', repo: 'widgets' } },
    githubResolveTarget: TARGET
  }
}

describe('the review reply a launch hands a structured chat', () => {
  it('resolves what the host can close and replies, in the thread or once on the PR, to the rest', () => {
    const live = [comment({ id: 12, threadId: 'T2', path: 'src/b.ts', line: 4 })]

    expect(buildPRCommentReviewReply(github(), live)).toEqual({
      provider: 'github',
      repoId: 'repo-1',
      prNumber: 42,
      prRepo: { owner: 'acme', repo: 'widgets' },
      resolve: ['T1'],
      replies: [{ commentId: 11, threadId: 'T2', path: 'src/b.ts', line: 4 }],
      replyBody: PR_COMMENT_AI_FIXING_REPLY,
      conversationReply: expect.stringContaining('Fixing')
    })
  })

  it('only resolves on GitLab', () => {
    const ack: PendingPRCommentAiAck = {
      ...github(),
      provider: 'gitlab',
      gitlabTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', iid: 8 }
    }

    expect(buildPRCommentReviewReply(ack, [])).toEqual({
      provider: 'gitlab',
      repoId: 'repo-1',
      iid: 8,
      resolve: ['T1']
    })
  })

  it('leaves off a reply past its bounds rather than fail the launch', () => {
    const many = Array.from({ length: MAX_REVIEW_REPLY_TARGETS + 1 }, (_, index) => ({
      kind: 'thread' as const,
      threadId: `T${index}`,
      root: comment({ id: index + 1, threadId: `T${index}`, path: 'a.ts', isResolved: false }),
      replies: []
    }))

    expect(buildPRCommentReviewReply({ ...github(), selectedGroups: many }, [])).toBeUndefined()
  })
})
