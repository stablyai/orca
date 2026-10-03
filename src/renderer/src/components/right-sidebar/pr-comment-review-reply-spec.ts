// The review reply a "Resolve comments with AI" launch hands a structured chat: what the checks
// panel would resolve and post after the paste, planned here and run by the host once the agent
// takes the message.

import type { PRComment } from '../../../../shared/github/comment-types'
import {
  AgentSessionReviewReplySchema,
  type AgentSessionReviewReply
} from '../../../../shared/agent-session-review-reply'
import { isResolvablePRCommentGroup } from '../pr-comments-resolution-prompt'
import {
  buildPRCommentBatchConversationReplyBody,
  PR_COMMENT_AI_FIXING_REPLY
} from './pr-comment-fixing-reply-body'
import {
  canPostPRReviewThreadReply,
  getPRCommentGroupReplyTarget,
  getPRCommentGroupsNeedingReply,
  resolvePRReviewReplyThreadId,
  type PendingPRCommentAiAck
} from './pr-comments-ai-launch-ack'

/** Undefined when the review has nothing a host can write to, or the spec breaks its bounds. */
export function buildPRCommentReviewReply(
  ack: PendingPRCommentAiAck,
  liveComments: readonly PRComment[]
): AgentSessionReviewReply | undefined {
  const resolve = ack.selectedGroups.filter(isResolvablePRCommentGroup).map((g) => g.threadId)
  const spec = reviewReplyFor(ack, resolve, liveComments)
  if (!spec) {
    return undefined
  }
  const parsed = AgentSessionReviewReplySchema.safeParse(spec)
  if (!parsed.success) {
    console.warn('Review reply left off the launch prompt:', parsed.error.message)
    return undefined
  }
  return parsed.data
}

function reviewReplyFor(
  ack: PendingPRCommentAiAck,
  resolve: string[],
  liveComments: readonly PRComment[]
): AgentSessionReviewReply | undefined {
  if (ack.provider === 'gitlab') {
    // GitLab acknowledges by resolving only, as the panel does after a paste.
    return ack.gitlabTarget
      ? { provider: 'gitlab', repoId: ack.gitlabTarget.repoId, iid: ack.gitlabTarget.iid, resolve }
      : undefined
  }
  const target = ack.githubResolveTarget
  if (ack.provider !== 'github' || !target) {
    return undefined
  }
  // Replies need the PR's repository, which only the reply target is sure to name.
  const replyTargets = ack.githubTarget
    ? getPRCommentGroupsNeedingReply(ack.selectedGroups).map(getPRCommentGroupReplyTarget)
    : []
  const inThread = replyTargets.filter(canPostPRReviewThreadReply)
  const conversation = replyTargets.filter((comment) => !canPostPRReviewThreadReply(comment))
  const prRepo = ack.githubTarget?.prRepo ?? target.prRepo
  return {
    provider: 'github',
    repoId: target.repoId,
    prNumber: target.prNumber,
    ...(prRepo
      ? {
          prRepo: {
            owner: prRepo.owner,
            repo: prRepo.repo,
            ...(prRepo.host ? { host: prRepo.host } : {})
          }
        }
      : {}),
    resolve,
    replies: inThread.map((comment) => {
      const threadId =
        resolvePRReviewReplyThreadId({ parent: comment, existingComments: liveComments }) ??
        comment.threadId
      return {
        commentId: comment.id,
        ...(threadId ? { threadId } : {}),
        ...(comment.path ? { path: comment.path } : {}),
        ...(comment.line !== undefined ? { line: comment.line } : {})
      }
    }),
    replyBody: PR_COMMENT_AI_FIXING_REPLY,
    ...(conversation.length > 0
      ? { conversationReply: buildPRCommentBatchConversationReplyBody(conversation) }
      : {})
  }
}
