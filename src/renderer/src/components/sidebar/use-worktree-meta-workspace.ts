import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { findIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { IssueLinkProvider } from '../../../../shared/issue-link-input'
import type { WorktreeMetaLiveLinks } from './worktree-meta-updates'

/** Resolves the workspace the meta dialog edits and the issue-link state it
 *  seeds from. Link state is read from the store rather than threaded through
 *  the untyped modalData bag — a call site that forgot a key would otherwise
 *  seed an empty field and silently destroy the link on save. */
export function useWorktreeMetaWorkspace(args: {
  worktreeId: string
  /** The repo bucket the opening row belongs to, when it knows. */
  ownerRepoId: string | null
  executionHostId?: string
}): {
  worktree: Worktree | undefined
  linkedIssue: number | null
  linkedLinearIssue: string | null
  /** The persisted value and its provider, from one source so they cannot drift. */
  currentIssue: string
  currentProvider: IssueLinkProvider
  isFolderWorkspace: boolean
  /** Link state as it stands now, for save-time displacement decisions. */
  liveLinks: WorktreeMetaLiveLinks
} {
  const { worktreeId, ownerRepoId, executionHostId } = args
  const workspaceScope = useMemo(() => parseWorkspaceKey(worktreeId), [worktreeId])
  const indexedWorktree = useAppStore((s) => {
    // Why: the same workspace ID can exist under two hosts, which the owner index
    // reports as ambiguous rather than guessing. The row that opened the dialog
    // knows which one it is; the index stays the fallback for callers that cannot.
    const scoped = ownerRepoId
      ? s.worktreesByRepo[ownerRepoId]?.find(
          (item) => item.id === worktreeId && (!executionHostId || item.hostId === executionHostId)
        )
      : undefined
    if (scoped) {
      return scoped
    }
    const owner = findIndexedWorktreeOwner(s.worktreesByRepo, worktreeId)
    return owner
      ? s.worktreesByRepo[owner.repoId]?.find((item) => item.id === worktreeId)
      : undefined
  })
  // Why: folder workspaces are absent from worktreesByRepo, so the lookup above
  // returns undefined and the row renders blank for them. The selector returns
  // the stored record — a stable reference — and the projection happens outside
  // it, because a selector that built the object would return a fresh identity
  // on every store write and re-render the dialog continuously.
  const folderWorkspace = useAppStore((s) =>
    workspaceScope?.type === 'folder'
      ? (s.folderWorkspaces.find((item) => item.id === workspaceScope.folderWorkspaceId) ?? null)
      : null
  )
  const worktree = useMemo(
    () => (folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : indexedWorktree),
    [folderWorkspace, indexedWorktree]
  )
  const linkedIssue = worktree?.linkedIssue ?? null
  const linkedLinearIssue = worktree?.linkedLinearIssue ?? null
  // Why: `typeof` rather than a null check — an unhydrated projection can leave
  // linkedIssue undefined, which `!== null` would read as a GitHub link.
  const currentProvider: IssueLinkProvider =
    typeof linkedIssue === 'number' ? 'github' : linkedLinearIssue ? 'linear' : 'github'
  const currentIssue =
    currentProvider === 'linear'
      ? (linkedLinearIssue ?? '')
      : typeof linkedIssue === 'number'
        ? String(linkedIssue)
        : ''
  // Why: displacement is decided against live state, not the frozen snapshot —
  // the dialog's warning reads the same values, so a link added by the CLI while
  // the dialog was open cannot outlive a save that promised to displace it.
  const liveLinks = useMemo<WorktreeMetaLiveLinks>(
    () => ({
      linkedPR: worktree?.linkedPR ?? null,
      linkedIssue,
      linkedLinearIssue,
      linkedLinearIssueOrganizationUrlKey: worktree?.linkedLinearIssueOrganizationUrlKey ?? null,
      linkedWorkItemProvider: worktree?.linkedWorkItem?.provider ?? null,
      linkedWorkItemType: worktree?.linkedWorkItem?.type ?? null
    }),
    [
      linkedIssue,
      linkedLinearIssue,
      worktree?.linkedPR,
      worktree?.linkedLinearIssueOrganizationUrlKey,
      worktree?.linkedWorkItem
    ]
  )

  return {
    worktree,
    linkedIssue,
    linkedLinearIssue,
    currentIssue,
    currentProvider,
    // Why: folder workspaces persist links only through their creation-time
    // linkedTask; updateWorktreeMeta drops link keys for them entirely.
    isFolderWorkspace: workspaceScope?.type === 'folder',
    liveLinks
  }
}
