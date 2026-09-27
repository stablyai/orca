import { sameBucketRecords, sameProjectedItems } from './bucket-record-equality'
import {
  type UnreadBadgeCountSources,
  type UnreadBadgeFolderWorkspace,
  type UnreadBadgeWorktree,
  getUnreadBadgeCount
} from './unread-badge-count'

/** Store fields the badge selector reads directly; floating unread is resolved by the injected selector. */
export type UnreadBadgeCountState = Pick<
  UnreadBadgeCountSources,
  'worktreesByRepo' | 'folderWorkspaces'
> & {
  settings: { floatingTerminalEnabled: boolean } | null
}

const EMPTY_BUCKETS = Object.freeze({})
const EMPTY_FOLDERS: readonly UnreadBadgeFolderWorkspace[] = Object.freeze([])

function sameBadgeWorkspace(
  previous: UnreadBadgeWorktree | UnreadBadgeFolderWorkspace,
  next: UnreadBadgeWorktree | UnreadBadgeFolderWorkspace
): boolean {
  return (
    previous.id === next.id &&
    previous.isUnread === next.isUnread &&
    previous.isArchived === next.isArchived
  )
}

/**
 * Builds a memoised App-root selector for the Dock badge integer.
 *
 * Why: the App root holds this subscription for a single integer. Returning the raw maps re-rendered
 * the whole shell on every agent title frame; selecting the count instead means the subscription
 * only notifies when the badge value can actually have moved.
 *
 * Why chaining against the immediately preceding state is enough: equality over the count's read set
 * — worktree and folder `id`/`isUnread`/`isArchived` plus the gated floating boolean — is transitive,
 * so a run of unchanged states is equivalent to comparing against the state that produced the count.
 *
 * `selectFloatingWorkspaceHasUnread` is injected so tests can prove it is skipped while disabled.
 */
export function createUnreadBadgeCountSelector<TState extends UnreadBadgeCountState>(
  selectFloatingWorkspaceHasUnread: (state: TState) => boolean
): (state: TState) => number {
  let previousWorktreesByRepo: UnreadBadgeCountSources['worktreesByRepo'] = EMPTY_BUCKETS
  let previousFolderWorkspaces: UnreadBadgeCountSources['folderWorkspaces'] = EMPTY_FOLDERS
  let previousFloatingWorkspaceHasUnread = false
  let unreadCount = 0
  let counted = false

  return (state) => {
    const floatingWorkspaceHasUnread =
      state.settings?.floatingTerminalEnabled === true && selectFloatingWorkspaceHasUnread(state)
    const unchanged =
      counted &&
      previousFloatingWorkspaceHasUnread === floatingWorkspaceHasUnread &&
      sameProjectedItems(previousFolderWorkspaces, state.folderWorkspaces, sameBadgeWorkspace) &&
      sameBucketRecords(previousWorktreesByRepo, state.worktreesByRepo, sameBadgeWorkspace)
    if (!unchanged) {
      unreadCount = getUnreadBadgeCount({
        worktreesByRepo: state.worktreesByRepo,
        folderWorkspaces: state.folderWorkspaces,
        floatingWorkspaceHasUnread
      })
      counted = true
    }
    previousWorktreesByRepo = state.worktreesByRepo
    previousFolderWorkspaces = state.folderWorkspaces
    previousFloatingWorkspaceHasUnread = floatingWorkspaceHasUnread
    return unreadCount
  }
}
