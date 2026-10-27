import { findWorktreeLineageRow } from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import type { AppState } from '../../../types'
import type { WorkspaceKey } from '../../../../../../shared/folder-workspace-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { getLineageInputs } from '../../../../components/sidebar/visible-worktree-indexes'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { lineageStoreKeyForRow } from '../../../../../../shared/resolved-worktree-lineage'
import type { ParentWorktreeRef } from '../../../../../../shared/worktree/lineage-types'
import { selectFolderWorkspaces } from '../../../workspace-record-selectors'
import { findIndexedFolderWorkspaceOwner } from '@/lib/worktree-runtime-owner-index'

import type { RuntimeClientTarget as RuntimeTarget } from '../../../../../../shared/runtime-client-target'
import type { CreatedWorktreeResult } from './worktree-create-payload'

export type CreateAttemptOutcome = {
  result: CreatedWorktreeResult
  /** The host had no such parent, so this attempt was retried unattached. */
  droppedParent: boolean
}

export type WorktreeCreateParentPick = {
  /** Workspace the create attaches to. Undefined once a stale pick is dropped. */
  parentWorkspace?: WorkspaceKey
  parentWorktreeRef?: ParentWorktreeRef
  /** Set only for an accepted user pick, whose lineage row must come back from the host. */
  pickedParentWorktreeId?: string
  /** Label for the drop warning; null when the parent record is already gone, '' when it has no name. */
  pickedDisplayName: string | null
  /** The pick no longer qualifies, so the create runs unattached. */
  staleBeforeCreate: boolean
}

/** True when the create landed without the nesting the caller asked for. */
export function lostRequestedParent(
  outcome: CreateAttemptOutcome,
  parent: WorktreeCreateParentPick,
  target: RuntimeTarget
): boolean {
  if (outcome.droppedParent) {
    return true
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
  const rows = getLineageInputs(state).worktreeMap
  const picked = requestedParentWorktreeId
    ? findWorktreeLineageRow(rows, requestedParentWorktreeId)
    : undefined
  const pickedHost = picked
    ? getWorktreeExecutionHostId(
        picked,
        state.repos.find((repo) => repo.id === picked.repoId)
      )
    : undefined
  const usable = picked && !picked.isArchived ? picked.id : undefined
  const pickedDisplayName = picked ? resolveWorktreeDisplayName(picked).trim() : null
  if (usable) {
    return {
      parentWorkspace: worktreeWorkspaceKey(usable),
      ...(picked?.instanceId && pickedHost !== executionHostId
        ? {
            parentWorktreeRef: {
              worktreeId: picked.id,
              instanceId: picked.instanceId,
              external:
                lineageStoreKeyForRow({ ...picked, hostId: pickedHost }) !==
                lineageStoreKeyForRow({ hostId: executionHostId })
            }
          }
        : {}),
      pickedParentWorktreeId: usable,
      pickedDisplayName,
      staleBeforeCreate: false
    }
  }
  const activeScope = parseWorkspaceKey(state.activeWorkspaceKey ?? '')
  const folder =
    activeScope?.type === 'folder'
      ? findIndexedFolderWorkspaceOwner(
          selectFolderWorkspaces(state),
          activeScope.folderWorkspaceId,
          state.activeWorkspaceExecutionHostId ?? undefined
        )
      : undefined
  const folderRow = folder ? folderWorkspaceToWorktree(folder) : undefined
  return {
    parentWorkspace:
      activeScope?.type === 'folder'
        ? folderWorkspaceKey(activeScope.folderWorkspaceId)
        : undefined,
    ...(folderRow?.instanceId && folderRow.hostId !== executionHostId
      ? {
          parentWorktreeRef: {
            worktreeId: folderRow.id,
            instanceId: folderRow.instanceId,
            external:
              lineageStoreKeyForRow(folderRow) !==
              lineageStoreKeyForRow({ hostId: executionHostId })
          }
        }
      : {}),
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
