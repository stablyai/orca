import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import type { Worktree } from './worktree/types'

/** Floating workspaces have no repo/worktree/folder row; synthesize a Worktree for filesystem resolution.
 * Keep the sentinel id: session journals and status subjects key by workspace id, so another identity would split the workspace. */
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
    // No project group owns this workspace; display-name readers must check id rather than repoId.
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
