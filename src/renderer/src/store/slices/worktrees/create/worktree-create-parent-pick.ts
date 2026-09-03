import type { AppState } from '../../../types'
import type { WorkspaceKey } from '../../../../../../shared/folder-workspace-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { getIndexedRepoOwners, getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { repoHostId } from '../listing/worktree-host-ownership'

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

/** Resolves the composer pick against the current store, falling back to the active folder scope. */
export function resolveWorktreeCreateParent(
  state: AppState,
  repoId: string,
  requestedParentWorktreeId: string | undefined,
  executionHostId?: ExecutionHostId
): WorktreeCreateParentPick {
  const pickedRows = requestedParentWorktreeId
    ? getIndexedWorktreesById(state.worktreesByRepo, requestedParentWorktreeId)
    : []
  const childHostId = repoHostId(state, repoId, executionHostId)
  const repoOwners = getIndexedRepoOwners(state.repos)
  const usableRows = pickedRows.filter((candidate) => {
    const candidateRepoOwners = repoOwners.get(candidate.repoId) ?? []
    const candidateRepo = candidateRepoOwners.length === 1 ? candidateRepoOwners[0] : undefined
    return (
      !candidate.isArchived &&
      (candidate.hostId !== undefined || candidateRepoOwners.length <= 1) &&
      getWorktreeExecutionHostId(candidate, candidateRepo) === childHostId
    )
  })
  const picked = usableRows.length === 1 ? usableRows[0] : undefined
  const usable = picked?.id
  const displayRow = picked ?? pickedRows[0]
  const pickedDisplayName = displayRow ? resolveWorktreeDisplayName(displayRow).trim() : null
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
