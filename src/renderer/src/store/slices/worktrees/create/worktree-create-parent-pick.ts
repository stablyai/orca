import type { AppState } from '../../../types'
import type { WorkspaceKey } from '../../../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../../../shared/execution-host'

export type WorktreeCreateParentPick = {
  /** Workspace the create attaches to. Undefined once a stale pick is dropped. */
  parentWorkspace?: WorkspaceKey
  /** Set only for an accepted user pick, whose lineage row must come back from the host. */
  pickedParentWorktreeId?: string
  /** Label for the drop warning; null when the parent record is already gone, '' when it has no name. */
  pickedDisplayName: string | null
  /** The pick no longer qualifies, so the create runs unattached. */
  staleBeforeCreate: boolean
}

/** Why: the composer keeps its pick across a repo switch, and a parent on another host must not be sent. */
function isOnCreateHost(
  state: AppState,
  picked: Pick<Worktree, 'hostId' | 'repoId'>,
  repoId: string
): boolean {
  const createRepo = state.repos.find((repo) => repo.id === repoId)
  if (!createRepo) {
    return picked.repoId === repoId
  }
  const pickedRepo = state.repos.find((repo) => repo.id === picked.repoId)
  return getWorktreeExecutionHostId(picked, pickedRepo) === getRepoExecutionHostId(createRepo)
}

/** Resolves the composer pick against the current store, falling back to the active folder scope. */
export function resolveWorktreeCreateParent(
  state: AppState,
  repoId: string,
  requestedParentWorktreeId: string | undefined
): WorktreeCreateParentPick {
  const picked = requestedParentWorktreeId
    ? getIndexedWorktreeById(state.worktreesByRepo, requestedParentWorktreeId)
    : undefined
  const usable =
    picked && !picked.isArchived && isOnCreateHost(state, picked, repoId) ? picked.id : undefined
  const pickedDisplayName = picked ? resolveWorktreeDisplayName(picked).trim() : null
  if (usable) {
    return {
      parentWorkspace: worktreeWorkspaceKey(usable),
      pickedParentWorktreeId: usable,
      pickedDisplayName,
      staleBeforeCreate: false
    }
  }
  const activeScope = parseWorkspaceKey(state.activeWorkspaceKey ?? '')
  return {
    parentWorkspace:
      activeScope?.type === 'folder'
        ? folderWorkspaceKey(activeScope.folderWorkspaceId)
        : undefined,
    pickedDisplayName,
    staleBeforeCreate: Boolean(requestedParentWorktreeId)
  }
}

/** Resolved late so the common create path never walks the folder-workspace list, and defensively
 *  so a missing label can never fail a create that already succeeded. */
function parentLabel(state: AppState, parent: WorktreeCreateParentPick): string | null {
  // Why not truthiness: a picked-but-unnamed worktree must warn unnamed, not name the active folder.
  if (parent.pickedDisplayName !== null) {
    return parent.pickedDisplayName || null
  }
  const scope = parent.parentWorkspace ? parseWorkspaceKey(parent.parentWorkspace) : null
  if (scope?.type !== 'folder') {
    return null
  }
  const workspace = state.folderWorkspaces?.find(
    (candidate) => candidate.id === scope.folderWorkspaceId
  )
  return workspace?.name.trim() || null
}

export function notifyWorktreeParentDropped(
  state: AppState,
  parent: WorktreeCreateParentPick
): void {
  const parentDisplayName = parentLabel(state, parent)
  toast.warning(
    parentDisplayName
      ? translate(
          'auto.store.slices.worktrees.createdWithoutParentNesting',
          'Created without nesting under "{{value0}}"',
          { value0: parentDisplayName }
        )
      : translate(
          'auto.store.slices.worktrees.createdWithoutParentNestingUnnamed',
          'Created without nesting under the selected parent'
        ),
    {
      description: translate(
        'auto.store.slices.worktrees.createdWithoutParentNestingDetail',
        'The parent workspace was no longer available. You can set it from the workspace menu.'
      )
    }
  )
}
