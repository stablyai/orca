import { sameBucketRecords } from './bucket-record-equality'
import {
  selectHiddenChildUnreadIdentities,
  type ChildWorktreeUnreadState
} from './child-worktree-unread-policy'
import {
  type UnreadBadgeCountSources,
  type UnreadBadgeTab,
  type UnreadBadgeOwnedTab,
  type UnreadBadgeWorktree,
  getUnreadBadgeCount
} from './unread-badge-count'

const EMPTY_BUCKETS = Object.freeze({})
type UnreadBadgeSelectorState = UnreadBadgeCountSources & ChildWorktreeUnreadState

function sameBadgeWorktree(previous: UnreadBadgeWorktree, next: UnreadBadgeWorktree): boolean {
  return (
    previous.id === next.id &&
    previous.isUnread === next.isUnread &&
    previous.hostId === next.hostId &&
    previous.runtimeOwnerEnvironmentId === next.runtimeOwnerEnvironmentId
  )
}

function sameBadgeTab(previous: UnreadBadgeTab, next: UnreadBadgeTab): boolean {
  return previous.id === next.id
}

function sameBadgeOwnedTab(previous: UnreadBadgeOwnedTab, next: UnreadBadgeOwnedTab): boolean {
  return (
    previous.id === next.id &&
    previous.worktreeId === next.worktreeId &&
    previous.executionHostId === next.executionHostId
  )
}

/**
 * Why: the App root holds this subscription for a single integer. Returning the raw maps re-rendered
 * the whole shell on every agent title frame; selecting the count instead means the subscription
 * only notifies when the badge value can actually have moved.
 *
 * Why chaining against the immediately preceding state is enough: equality over the count's read set
 * — workspace identity/unread, tab identity/owner, unread map and hidden-child set — is transitive, so a run of
 * unchanged states is equivalent to comparing against the state that produced the cached count.
 */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeSelectorState) => number {
  let previousWorktreesByRepo: UnreadBadgeCountSources['worktreesByRepo'] = EMPTY_BUCKETS
  let previousTabsByWorktree: UnreadBadgeCountSources['tabsByWorktree'] = EMPTY_BUCKETS
  let previousUnifiedTabs: NonNullable<UnreadBadgeCountSources['unifiedTabsByWorktree']> =
    EMPTY_BUCKETS
  let previousUnreadTerminalTabs: UnreadBadgeCountSources['unreadTerminalTabs'] | undefined
  let previousHiddenChildUnreadIdentities: ReadonlySet<string> | undefined
  let unreadCount = 0
  let counted = false

  return (state) => {
    const hiddenChildUnreadIdentities = selectHiddenChildUnreadIdentities(state)
    const unifiedTabs = state.unifiedTabsByWorktree ?? EMPTY_BUCKETS
    const unchanged =
      counted &&
      previousHiddenChildUnreadIdentities === hiddenChildUnreadIdentities &&
      previousUnreadTerminalTabs === state.unreadTerminalTabs &&
      sameBucketRecords(previousWorktreesByRepo, state.worktreesByRepo, sameBadgeWorktree) &&
      sameBucketRecords(previousTabsByWorktree, state.tabsByWorktree, sameBadgeTab) &&
      sameBucketRecords(previousUnifiedTabs, unifiedTabs, sameBadgeOwnedTab)
    if (!unchanged) {
      unreadCount = getUnreadBadgeCount({
        worktreesByRepo: state.worktreesByRepo,
        tabsByWorktree: state.tabsByWorktree,
        unreadTerminalTabs: state.unreadTerminalTabs,
        hiddenChildUnreadIdentities,
        unifiedTabsByWorktree: unifiedTabs
      })
      previousHiddenChildUnreadIdentities = hiddenChildUnreadIdentities
      previousUnreadTerminalTabs = state.unreadTerminalTabs
      counted = true
    }
    previousWorktreesByRepo = state.worktreesByRepo
    previousTabsByWorktree = state.tabsByWorktree
    previousUnifiedTabs = unifiedTabs
    return unreadCount
  }
}
