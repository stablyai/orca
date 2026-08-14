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
  /**
   * Nested review-thread reply (pulls/.../comments/{id}/replies).
   * Only call when canPostPRReviewThreadReply(comment) is true.
   */
  replyInThread: (comment: PRComment, body: string) => Promise<boolean>
  /**
   * One top-level PR conversation comment (issues/.../comments) covering every selected
   * comment with no nested-reply endpoint (review summaries, CodeRabbit, plain comments).
   */
  replyAsConversation: (body: string) => Promise<boolean>
}

/**
 * True when GitHub can nest a reply under this comment (inline review-thread comment).
 * Conversation comments and PR review summaries (CodeRabbit, etc.) cannot use that API.
 */
export function canPostPRReviewThreadReply(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>
): boolean {
  if (!Number.isSafeInteger(comment.id) || comment.id <= 0) {
    return false
  }
  // Why: review-summary anchors use #pullrequestreview-N; that id is not a review
  // comment id and will 404 on the replies endpoint.
  if (typeof comment.url === 'string' && comment.url.includes('pullrequestreview')) {
    return false
  }
  // Why: threadId is the GraphQL thread key; path marks review comments even when
  // thread metadata is missing; #discussion_r is the REST anchor for review comments.
  if (Boolean(comment.threadId) || Boolean(comment.path)) {
    return true
  }
  return typeof comment.url === 'string' && comment.url.includes('discussion_r')
}

/**
 * Reply to the thread root: GitHub's replies endpoint keys off the top-level review
 * comment id, and a later reply's id can 404 there.
 */
export function getPRCommentGroupReplyTarget(group: PRCommentGroup): PRComment {
  return getPRCommentGroupRoot(group)
}

/**
 * Attach parent review-thread metadata so the sidebar groups the reply under the
 * original comment immediately (GitHub REST replies often omit threadId/path).
 */
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

/**
 * Resolve a threadId for a reply target from the live comment list when the
 * target itself is missing one (path-only review comments).
 */
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

/**
 * Drop the trailing headSha segment from a checks-panel async key.
 * Agent launch (submit-after-ready) can take long enough for PR head to move;
 * ack must not abort just because headSha churned.
 */
export function checksPanelReviewStableKey(asyncResultKey: string): string {
  const parts = asyncResultKey.split('::')
  if (parts.length <= 1) {
    return asyncResultKey
  }
  return parts.slice(0, -1).join('::')
}

/**
 * Bulk ack fans out over the host API (`gh`), which is slow on SSH; the shared
 * client already caps itself at 4 in-flight requests, so match that ceiling.
 */
export const PR_COMMENT_ACK_MAX_CONCURRENCY = 4

const EMPTY_ACK_COUNTS: PRCommentAiLaunchAckCounts = {
  resolved: 0,
  replied: 0,
  skipped: 0,
  failed: 0
}

/** Fixed-size worker pool; results stay in input order. */
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

/** Emptiness test for the above without materializing the filtered list. */
export function hasPRCommentGroupNeedingReply(groups: readonly PRCommentGroup[]): boolean {
  return groups.some((group) => !isResolvablePRCommentGroup(group))
}

/**
 * After launching an agent for selected review feedback, acknowledge every selection
 * exactly once: host-resolvable threads are resolved, and anything the host cannot close
 * gets a fixing reply (one nested reply per review thread, one combined conversation
 * comment for everything with no nested-reply endpoint).
 *
 * Why resolve instead of reply: a resolved thread collapses on the host, which *is* the
 * acknowledgement — an extra "Fixing." comment only adds noise to a thread the user can
 * already see is handled.
 *
 * Every host call targets state snapshotted at launch, so a slow agent start or the user
 * navigating away can no longer silently drop the resolve. Groups run through a bounded pool.
 */
export async function acknowledgePRCommentsAfterAiLaunch(args: {
  groups: readonly PRCommentGroup[]
  deps: PRCommentAiLaunchAckDeps
}): Promise<PRCommentAiLaunchAckCounts> {
  // Why: conversation comments have no replies endpoint, so one post per selected item
  // would spam the PR timeline with near-identical "Fixing." comments.
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
    // Why: one host POST covers the whole set, so the toast must count it once.
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

/** Mutates counts in place. */
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

/**
 * Snapshotted at queue time so the post-launch ack does not depend on live React state.
 * Resolving a thread only needs the PR handle — prRepo is optional on resolveReviewThread,
 * so a PR cache entry without it must still be able to ack by resolving.
 */
export type PendingPRCommentAiAckGithubResolveTarget = {
  repoPath: string
  repoId: string
  prNumber: number
  prRepo?: NonNullable<PRInfo['prRepo']>
}

/** The reply endpoints genuinely need prRepo, so they get the stricter target. */
export type PendingPRCommentAiAckGithubTarget = PendingPRCommentAiAckGithubResolveTarget & {
  prRepo: NonNullable<PRInfo['prRepo']>
}

/** Snapshotted at queue time so the post-launch ack does not depend on live React state. */
export type PendingPRCommentAiAckGitlabTarget = {
  repoPath: string
  repoId: string
  iid: number
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

/**
 * The slot only ever holds an *unclaimed* queue: an accepted launch takes ownership via
 * takePendingPRCommentAiAck and parks the payload itself. Replacing an unclaimed payload is
 * how a re-opened composer re-queues, so log it — a clobbered accepted launch would be a bug.
 */
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
