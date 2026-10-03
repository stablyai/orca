import { sameBucketRecords } from './bucket-record-equality'
import {
  type UnreadBadgeCountSources,
  type UnreadBadgeWorktree,
  getUnreadBadgeCount
} from './unread-badge-count'

const EMPTY_BUCKETS = Object.freeze({})

function sameBadgeWorktree(previous: UnreadBadgeWorktree, next: UnreadBadgeWorktree): boolean {
  return (
    previous.id === next.id &&
    previous.hostId === next.hostId &&
    previous.isUnread === next.isUnread &&
    previous.isArchived === next.isArchived
  )
}

/**
 * Why: the App root holds this subscription for a single integer. Returning the raw maps re-rendered
 * the whole shell on every agent title frame; selecting the count instead means the subscription
 * only notifies when the badge value can actually have moved.
 *
 * Why chaining against the immediately preceding state is enough: equality over the count's read set
 * — the worktree projection and the folder workspace list identity — is transitive, so a run of
 * unchanged states is equivalent to comparing against the state that produced the cached count.
 */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeCountSources) => number {
  let previousWorktreesByRepo: UnreadBadgeCountSources['worktreesByRepo'] = EMPTY_BUCKETS
  let previousFolderWorkspaces: UnreadBadgeCountSources['folderWorkspaces'] | undefined
  let unreadCount = 0
  let counted = false

  return (state) => {
    const unchanged =
      counted &&
      previousFolderWorkspaces === state.folderWorkspaces &&
      sameBucketRecords(previousWorktreesByRepo, state.worktreesByRepo, sameBadgeWorktree)
    if (!unchanged) {
      unreadCount = getUnreadBadgeCount(state)
      previousFolderWorkspaces = state.folderWorkspaces
      counted = true
    }
    previousWorktreesByRepo = state.worktreesByRepo
    return unreadCount
  }
}
