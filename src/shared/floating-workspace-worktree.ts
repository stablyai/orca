import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import type { Worktree } from './worktree/types'

/**
 * The floating workspace is a directory the user points Orca at, with no repo, worktree or folder
 * row behind it. Anything that resolves a workspace to a filesystem location needs an answer for
 * it, so this mints the same synthetic `Worktree` shape folder workspaces use.
 *
 * Its id stays the sentinel constant: the session journal and every status subject are keyed by
 * workspace id, so inventing a second identity here would split one workspace into two.
 *
 * Minting and recognising it live together so the two cannot drift.
 */
export function isFloatingWorkspaceId(worktreeId: string | null | undefined): boolean {
  return worktreeId === FLOATING_TERMINAL_WORKTREE_ID
}

/** Accepts the bare sentinel or the `id:` selector the runtime resolves targets with. */
export function isFloatingWorkspaceSelector(selector: string | null | undefined): boolean {
  return (
    selector === FLOATING_TERMINAL_WORKTREE_ID || selector === `id:${FLOATING_TERMINAL_WORKTREE_ID}`
  )
}

/** `path` is the resolved floating directory; the caller owns resolving it from settings. */
export function floatingWorkspaceToWorktree(path: string): Worktree {
  return {
    id: FLOATING_TERMINAL_WORKTREE_ID,
    // Why: no project group stands behind it, unlike a folder workspace. Readers that resolve a
    // display name must test the id, not this slot.
    repoId: FLOATING_TERMINAL_WORKTREE_ID,
    displayName: 'Floating workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    manualOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    pendingFirstAgentMessageRename: false,

    diffComments: [],
    path,
    head: '',
    branch: '',
    isBare: false,
    isSparse: false,
    isMainWorktree: false,
    hostId: 'local'
  }
}
