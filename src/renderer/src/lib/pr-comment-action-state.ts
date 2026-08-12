import { getPRCommentGroupRoot, type PRCommentGroup } from '../../../shared/pr-comment-groups'
import type { PRComment } from '../../../shared/types'

/** How a comment group should read in the PR sidebar triage UI. */
export type PRCommentGroupActionState = 'open' | 'conversation' | 'resolved'

/** Whether Orca knows this thread is still open on the host. */
export function getPRCommentGroupActionState(group: PRCommentGroup): PRCommentGroupActionState {
  const root = getPRCommentGroupRoot(group)
  if (root.isResolved === true) {
    return 'resolved'
  }
  if (root.threadId && root.isResolved === false) {
    return 'open'
  }
  return 'conversation'
}

/** Groups the agent can address via the resolve-comments workflow. */
export function isPRCommentGroupQueueableForAI(group: PRCommentGroup): boolean {
  return getPRCommentGroupActionState(group) !== 'resolved'
}

export function partitionPRCommentGroupsForTriage(groups: readonly PRCommentGroup[]): {
  open: PRCommentGroup[]
  conversation: PRCommentGroup[]
  resolved: PRCommentGroup[]
} {
  const open: PRCommentGroup[] = []
  const conversation: PRCommentGroup[] = []
  const resolved: PRCommentGroup[] = []
  for (const group of groups) {
    const state = getPRCommentGroupActionState(group)
    if (state === 'resolved') {
      resolved.push(group)
    } else if (state === 'open') {
      open.push(group)
    } else {
      conversation.push(group)
    }
  }
  return { open, conversation, resolved }
}

/** Null when the host sent an unparseable (often empty) `createdAt`. */
function commentMs(comment: PRComment): number | null {
  const ts = Date.parse(comment.createdAt)
  return Number.isNaN(ts) ? null : ts
}

function groupStartMs(group: PRCommentGroup): number | null {
  return commentMs(getPRCommentGroupRoot(group))
}

/** Newest comment anywhere in the group, so a fresh reply refreshes an old thread. */
function groupLatestActivityMs(group: PRCommentGroup): number | null {
  if (group.kind !== 'thread') {
    return commentMs(group.comment)
  }
  return group.replies.reduce<number | null>((latest, reply) => {
    const ts = commentMs(reply)
    if (ts === null) {
      return latest
    }
    return latest === null ? ts : Math.max(latest, ts)
  }, commentMs(group.root))
}

/**
 * Orders comment groups by time. The two orders use different keys, not just opposite
 * directions: `newest-first` ranks by last activity anywhere in the thread, while
 * `oldest-first` ranks by when the thread started. Groups whose timestamp is unknown
 * sort last in both orders.
 */
export function sortPRCommentGroupsByRecency(
  groups: readonly PRCommentGroup[],
  order: 'oldest-first' | 'newest-first' = 'oldest-first'
): PRCommentGroup[] {
  const newestFirst = order === 'newest-first'
  const multiplier = newestFirst ? -1 : 1
  const timestampOf = newestFirst ? groupLatestActivityMs : groupStartMs
  // Why: decorate first so each group parses its dates once, not once per comparison.
  return groups
    .map((group) => ({ group, ts: timestampOf(group), id: getPRCommentGroupRoot(group).id }))
    .sort((left, right) => {
      if (left.ts === null || right.ts === null) {
        if (left.ts !== null) {
          return -1
        }
        if (right.ts !== null) {
          return 1
        }
        return multiplier * (left.id - right.id)
      }
      // Why: ids break the ties GitHub creates by stamping a whole review batch identically.
      return multiplier * (left.ts - right.ts || left.id - right.id)
    })
    .map((entry) => entry.group)
}
