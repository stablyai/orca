import type { AppState } from '../../../types'

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import {
  type WorkspaceKey,
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { getIndexedAllWorktrees, getIndexedWorktreesById } from '@/store/worktree-repo-index'
import {
  getWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { CreatedWorktreeResult } from './worktree-create-payload'
import { resolveReviewRepository } from '@/lib/review-owner'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../../../workspace-record-selectors'

export type CreateAttemptOutcome = {
  result: CreatedWorktreeResult
  /** The host had no such parent, so this attempt was retried unattached. */
  droppedParent: boolean
}

export type WorktreeCreateParentPick = {
  /** Workspace the create attaches to. Undefined once a stale pick is dropped. */
  parentWorkspace?: WorkspaceKey
  /** Set only for an accepted user pick, whose lineage row must come back from the host. */
  pickedParentWorktreeId?: string
  /** A picked parent on another machine (by host identity); its own store names it before create. */
  crossStoreParentRow?: Worktree
  /** Label for the drop warning; null when the parent record is already gone, '' when it has no name. */
  pickedDisplayName: string | null
  /** The pick no longer qualifies, so the create runs unattached. */
  staleBeforeCreate: boolean
}

/** True when the create landed without the nesting the caller asked for. */
export function lostRequestedParent(
  outcome: CreateAttemptOutcome,
  parent: WorktreeCreateParentPick,
  target: RuntimeClientTarget
): boolean {
  if (outcome.droppedParent) {
    return true
  }
  if (parent.crossStoreParentRow) {
    return !outcome.result.crossStoreLineage
  }
  if (parent.pickedParentWorktreeId) {
    return !outcome.result.lineage
  }
  // Why local-only: older hosts predate the top-level workspace lineage field, so its absence
  // over RPC would warn about a nesting that actually landed.
  return (
    target.kind === 'local' && Boolean(parent.parentWorkspace) && !outcome.result.workspaceLineage
  )
}

/** Resolves the composer pick against the current store, falling back to the active folder scope. */
export function resolveWorktreeCreateParent(
  state: AppState,
  requestedParentWorktreeId: string | undefined,
  executionHostId: ExecutionHostId
): WorktreeCreateParentPick {
  const isOnCreationHost = (candidate: Worktree): boolean => {
    const repo = resolveReviewRepository(state.repos, candidate)
    return Boolean(repo && getRepoExecutionHostId(repo) === executionHostId)
  }
  let picked: Worktree | undefined
  if (requestedParentWorktreeId && isWorktreeHostIdentity(requestedParentWorktreeId)) {
    const row = getIndexedAllWorktrees(selectWorktreesByRepo(state)).find(
      (candidate) => getWorktreeHostIdentity(candidate) === requestedParentWorktreeId
    )
    // The pick outlives a destination change; a parent now on the creation host is an ordinary one.
    if (row && !row.isArchived && !isOnCreationHost(row)) {
      return {
        crossStoreParentRow: row,
        pickedParentWorktreeId: row.id,
        pickedDisplayName: resolveWorktreeDisplayName(row).trim(),
        staleBeforeCreate: false
      }
    }
    if (!row || row.isArchived) {
      return {
        pickedDisplayName: row ? resolveWorktreeDisplayName(row).trim() : null,
        staleBeforeCreate: true
      }
    }
    picked = row
  } else if (requestedParentWorktreeId) {
    picked = getIndexedWorktreesById(selectWorktreesByRepo(state), requestedParentWorktreeId).find(
      isOnCreationHost
    )
  }
  const usable = picked && !picked.isArchived ? picked.id : undefined
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

/** Resolve label only for warnings; missing labels must never fail an already successful create. */
function parentLabel(state: AppState, parent: WorktreeCreateParentPick): string | null {
  // Why not truthiness: a picked-but-unnamed worktree must warn unnamed, not name the active folder.
  if (parent.pickedDisplayName !== null) {
    return parent.pickedDisplayName || null
  }
  const scope = parent.parentWorkspace ? parseWorkspaceKey(parent.parentWorkspace) : null
  if (scope?.type !== 'folder') {
    return null
  }
  const workspace = selectFolderWorkspaces(state)?.find(
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
