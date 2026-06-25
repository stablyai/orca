import type { PRCommentGroup } from './pr-comment-groups'
import { getPRCommentGroupId, getPRCommentGroupRoot } from './pr-comment-groups'

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

function groupTimelineMs(group: PRCommentGroup): number {
  const ts = Date.parse(getPRCommentGroupRoot(group).createdAt)
  return Number.isNaN(ts) ? 0 : ts
}

export function sortPRCommentGroupsForTimeline(
  groups: readonly PRCommentGroup[]
): PRCommentGroup[] {
  return [...groups].sort(
    (left, right) =>
      groupTimelineMs(left) - groupTimelineMs(right) ||
      getPRCommentGroupId(left).localeCompare(getPRCommentGroupId(right))
  )
}
