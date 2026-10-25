/** Which emptied-workspace closes start a workspace delete; exits are process exits, not user closes. */
export type LastTabAutoDeleteMode = 'off' | 'close' | 'close-or-exit' | 'close-or-exit-background'

const LAST_TAB_AUTO_DELETE_MODES: readonly string[] = [
  'off',
  'close',
  'close-or-exit',
  'close-or-exit-background'
] satisfies readonly LastTabAutoDeleteMode[]

/** Unknown values (a newer build's mode after a downgrade, a hand edit) read as off, never as on. */
export function readLastTabAutoDeleteMode(value: unknown): LastTabAutoDeleteMode {
  return typeof value === 'string' && LAST_TAB_AUTO_DELETE_MODES.includes(value)
    ? (value as LastTabAutoDeleteMode)
    : 'off'
}

export type WorktreeDeletionPreferences = {
  /** Worktree deletion removes the working directory, so confirmation is on by default. */
  skipDeleteWorktreeConfirm: boolean
  /** Opt-in: workspace deletion discards changes and may waive terminal-stop verification. */
  alwaysForceDeleteWorktrees?: boolean
  /** Opt-in: delete preserved local branches after workspace removal. */
  alwaysForceDeletePreservedBranches?: boolean
  /** Opt-in: closing a workspace's last tab runs the normal workspace delete. */
  deleteWorkspaceOnLastTabClose?: LastTabAutoDeleteMode
  /** Pinned workspaces are kept when their last tab closes. */
  lastTabDeleteSkipPinned?: boolean
  /** Folder workspaces are kept when their last tab closes. */
  lastTabDeleteSkipFolder?: boolean
  /** SSH workspaces are kept when their last tab closes. */
  lastTabDeleteSkipSsh?: boolean
}

/** Saved with an immediate flush: a crash right after changing one must not revert it. */
export const DURABLE_DELETION_PREFERENCE_KEYS = [
  'alwaysForceDeleteWorktrees',
  'alwaysForceDeletePreservedBranches',
  'deleteWorkspaceOnLastTabClose',
  'lastTabDeleteSkipPinned',
  'lastTabDeleteSkipFolder',
  'lastTabDeleteSkipSsh'
] as const satisfies readonly (keyof WorktreeDeletionPreferences)[]
