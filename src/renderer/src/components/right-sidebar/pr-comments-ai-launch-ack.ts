import type { PRComment } from '../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { getPRCommentGroupRoot, type PRCommentGroup } from '../../../../shared/pr-comment-groups'
import { isResolvablePRCommentGroup } from '../pr-comments-resolution-prompt'
import {
  buildPRCommentBatchConversationReplyBody,
  PR_COMMENT_AI_FIXING_REPLY
} from './pr-comment-fixing-reply-body'

export type PRCommentAiLaunchAckCounts = {
  resolved: number
  replied: number
  skipped: number
  failed: number
}

export type PRCommentAiLaunchAckDeps = {
  /** Resolve a host thread. Always called against the threadId snapshotted at launch. */
  resolveThread: (threadId: string) => Promise<boolean>
  /** Provider supports posting a reply (GitHub in the Checks panel today). */
  canReply: boolean
  /** Nested review reply API; call only when canPostPRReviewThreadReply allows it. */
  replyInThread: (comment: PRComment, body: string) => Promise<boolean>
  /** One conversation post for selected summaries/plain comments without nested-reply endpoints. */
  replyAsConversation: (body: string) => Promise<boolean>
}

/** Only inline review-thread comments support nested replies; conversation comments and review summaries do not. */
export function canPostPRReviewThreadReply(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>
): boolean {
  if (!Number.isSafeInteger(comment.id) || comment.id <= 0) {
    return false
  }
  // Review-summary anchors name review IDs, not comment IDs; nested replies would 404.
  if (typeof comment.url === 'string' && comment.url.includes('pullrequestreview')) {
    return false
  }
  // threadId/path identify review comments even without complete metadata; discussion_r is their REST anchor.
  if (Boolean(comment.threadId) || Boolean(comment.path)) {
    return true
  }
  return typeof comment.url === 'string' && comment.url.includes('discussion_r')
}

/** Reply using the thread root ID; later reply IDs can 404 on GitHub's endpoint. */
export function getPRCommentGroupReplyTarget(group: PRCommentGroup): PRComment {
  return getPRCommentGroupRoot(group)
}

/** Restore parent metadata omitted by REST so the sidebar immediately groups replies under their thread. */
export function attachPRReviewReplyParent(
  reply: PRComment,
  parent: Pick<PRComment, 'threadId' | 'path' | 'line' | 'isResolved' | 'isOutdated' | 'startLine'>
): PRComment {
  return {
    ...reply,
    threadId: reply.threadId ?? parent.threadId,
    path: reply.path ?? parent.path,
    line: reply.line ?? parent.line,
    startLine: reply.startLine ?? parent.startLine,
    isResolved: reply.isResolved ?? parent.isResolved,
    isOutdated: reply.isOutdated ?? parent.isOutdated
  }
}

/** Recover missing thread IDs for path-only reply targets from the live comment list. */
export function resolvePRReviewReplyThreadId(args: {
  parent: Pick<PRComment, 'id' | 'threadId' | 'path' | 'line'>
  existingComments: readonly PRComment[]
}): string | undefined {
  if (args.parent.threadId) {
    return args.parent.threadId
  }
  const byId = args.existingComments.find(
    (comment) => comment.id === args.parent.id && Boolean(comment.threadId)
  )
  if (byId?.threadId) {
    return byId.threadId
  }
  if (!args.parent.path) {
    return undefined
  }
  const siblingThreadIds = new Set(
    args.existingComments.flatMap((comment) =>
      comment.threadId &&
      comment.path === args.parent.path &&
      (args.parent.line == null || comment.line === args.parent.line)
        ? [comment.threadId]
        : []
    )
  )
  // Why: several threads on one file give no reliable parent; a wrong threadId misfiles the reply.
  return siblingThreadIds.size === 1 ? [...siblingThreadIds][0] : undefined
}

/** Ignore trailing headSha churn so slow agent launches do not abort acknowledgements after head changes. */
export function checksPanelReviewStableKey(asyncResultKey: string): string {
  const parts = asyncResultKey.split('::')
  if (parts.length <= 1) {
    return asyncResultKey
  }
  return parts.slice(0, -1).join('::')
}

/** Match the shared host client's four-request cap; bulk gh calls are slow over SSH. */
export const PR_COMMENT_ACK_MAX_CONCURRENCY = 4

const EMPTY_ACK_COUNTS: PRCommentAiLaunchAckCounts = {
  resolved: 0,
  replied: 0,
  skipped: 0,
  failed: 0
}

async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

type BatchedConversationReply = {
  counts: PRCommentAiLaunchAckCounts
  handled: ReadonlySet<PRCommentGroup>
}

const NO_BATCHED_CONVERSATION_REPLY: BatchedConversationReply = {
  counts: EMPTY_ACK_COUNTS,
  handled: new Set()
}

/** Groups that need a posted reply because the host cannot close them for us. */
export function getPRCommentGroupsNeedingReply(
  groups: readonly PRCommentGroup[]
): PRCommentGroup[] {
  return groups.filter((group) => !isResolvablePRCommentGroup(group))
}

export function hasPRCommentGroupNeedingReply(groups: readonly PRCommentGroup[]): boolean {
  return groups.some((group) => !isResolvablePRCommentGroup(group))
}

/** Acknowledge launch-snapshotted selections once: resolve closable threads, nest other review replies, and batch remaining comments; bound concurrency. */
export async function acknowledgePRCommentsAfterAiLaunch(args: {
  groups: readonly PRCommentGroup[]
  deps: PRCommentAiLaunchAckDeps
}): Promise<PRCommentAiLaunchAckCounts> {
  // Conversation comments lack nested replies; batch them to avoid repeated Fixing timeline posts.
  const conversationGroups = args.deps.canReply
    ? getPRCommentGroupsNeedingReply(args.groups).filter(
        (group) => !canPostPRReviewThreadReply(getPRCommentGroupReplyTarget(group))
      )
    : []
  const batch = await postBatchedConversationReply(conversationGroups, args.deps)

  const perGroup = await mapWithBoundedConcurrency(
    args.groups,
    PR_COMMENT_ACK_MAX_CONCURRENCY,
    (group) => acknowledgePRCommentGroup(group, args.deps, batch)
  )

  return [batch.counts, ...perGroup].reduce<PRCommentAiLaunchAckCounts>(
    (totals, counts) => ({
      resolved: totals.resolved + counts.resolved,
      replied: totals.replied + counts.replied,
      skipped: totals.skipped + counts.skipped,
      failed: totals.failed + counts.failed
    }),
    EMPTY_ACK_COUNTS
  )
}

async function postBatchedConversationReply(
  groups: readonly PRCommentGroup[],
  deps: PRCommentAiLaunchAckDeps
): Promise<BatchedConversationReply> {
  if (groups.length === 0) {
    return NO_BATCHED_CONVERSATION_REPLY
  }
  const replyOk = await deps.replyAsConversation(
    buildPRCommentBatchConversationReplyBody(groups.map(getPRCommentGroupReplyTarget))
  )
  return {
    // Count the combined host POST once for the toast.
    counts: { ...EMPTY_ACK_COUNTS, replied: replyOk ? 1 : 0, failed: replyOk ? 0 : 1 },
    handled: new Set(groups)
  }
}

async function acknowledgePRCommentGroup(
  group: PRCommentGroup,
  deps: PRCommentAiLaunchAckDeps,
  batch: BatchedConversationReply
): Promise<PRCommentAiLaunchAckCounts> {
  const counts = { ...EMPTY_ACK_COUNTS }

  if (isResolvablePRCommentGroup(group)) {
    if (await deps.resolveThread(group.threadId)) {
      counts.resolved += 1
    } else {
      counts.failed += 1
    }
    return counts
  }

  if (!deps.canReply) {
    counts.skipped += 1
    return counts
  }
  // The combined conversation post already covered this group and counted itself.
  if (batch.handled.has(group)) {
    return counts
  }
  await postInThreadFixingReply(group, deps, counts)
  return counts
}

async function postInThreadFixingReply(
  group: PRCommentGroup,
  deps: PRCommentAiLaunchAckDeps,
  counts: PRCommentAiLaunchAckCounts
): Promise<void> {
  const replyOk = await deps.replyInThread(
    getPRCommentGroupReplyTarget(group),
    PR_COMMENT_AI_FIXING_REPLY
  )
  if (replyOk) {
    counts.replied += 1
  } else {
    counts.failed += 1
  }
}

/** Pin resolve targets at queue time; prRepo remains optional so degraded PR cache entries can still acknowledge threads. */
export type PendingPRCommentAiAckGithubResolveTarget = {
  repoPath: string
  repoId: string
  prNumber: number
  prRepo?: NonNullable<PRInfo['prRepo']>
}

/** Reply endpoints require the stricter prRepo target. */
export type PendingPRCommentAiAckGithubTarget = PendingPRCommentAiAckGithubResolveTarget & {
  prRepo: NonNullable<PRInfo['prRepo']>
}

/** Snapshotted at queue time so the post-launch ack does not depend on live React state. */
export type PendingPRCommentAiAckGitlabTarget = {
  repoPath: string
  repoId: string
  iid: number
  /** The MR's credential host, pinned at launch; repo ids can repeat across hosts. */
  ownerHostId: string
}

/** What a queued comment-resolution launch must still ack once its prompt is delivered. */
export type PendingPRCommentAiAck = {
  reviewContextKey: string
  provider: HostedReviewInfo['provider']
  selectedGroups: PRCommentGroup[]
  /** Reply target: requires prRepo. */
  githubTarget?: PendingPRCommentAiAckGithubTarget
  githubResolveTarget?: PendingPRCommentAiAckGithubResolveTarget
  gitlabTarget?: PendingPRCommentAiAckGitlabTarget
}

/** Durable pending ack payload so dialog close / re-renders cannot drop it before launch. */
let pendingAiCommentAck: PendingPRCommentAiAck | null = null

/** This slot holds unclaimed queues only; accepted launches take ownership, while reopened composers may replace and log queued payloads. */
export function setPendingPRCommentAiAck(payload: PendingPRCommentAiAck): void {
  if (pendingAiCommentAck && pendingAiCommentAck !== payload) {
    console.warn(
      'Replacing an unclaimed PR comment ack payload',
      pendingAiCommentAck.reviewContextKey,
      '->',
      payload.reviewContextKey
    )
  }
  pendingAiCommentAck = payload
}

export function takePendingPRCommentAiAck(): PendingPRCommentAiAck | null {
  const payload = pendingAiCommentAck
  pendingAiCommentAck = null
  return payload
}

export function clearPendingPRCommentAiAck(): void {
  pendingAiCommentAck = null
}
