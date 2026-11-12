import type { WorkspaceAttachmentMutation } from '../../../../../../shared/workspace-attachments/workspace-attachment-mutation'
import type { AppState } from '../../../types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'

import {
  type ExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import {
  floatingWorkspaceToWorktree,
  isFloatingWorkspaceId
} from '../../../../../../shared/floating-workspace-worktree'
import { findIndexedDetectedWorktrees } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { findFirstIndexedWorktree } from '../../../../lib/workspace/ownership/worktree-runtime-owner-index'
import { withoutErasedRequiredWorktreeFields } from '../metadata/worktree-meta-update-application'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  type WorkspaceRecordState,
  selectWorkspaceByHostTarget
} from '../../../workspaces/selection/workspace-host-target'
import { resolveQualifiedIndexedFolderWorkspace } from '../../../folder-workspaces/folder-workspace-record-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../workspaces/catalog/workspace-record-fields'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'

// Why a one-slot cache: the floating workspace is a singleton; retained selectors only need the
// row's identity to hold while the resolved directory is unchanged.
let floatingWorkspaceWorktreeCache: { path: string; worktree: Worktree } | null = null

import { worktreeRowMatchesMetaHost } from './worktree-meta-host-match'
import { branchName } from '@/lib/source-control/branches/branch-name'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments/workspace-attachments'

export function applyDetectedWorktreeUpdates(
  detectedWorktreesByRepo: AppState['detectedWorktreesByRepo'],
  worktreeId: string,
  rawUpdates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId
): AppState['detectedWorktreesByRepo'] {
  // Why: mirrors applyWorktreeUpdates — detected rows feed the same palette.
  const updates = withoutErasedRequiredWorktreeFields(rawUpdates)
  let changed = false
  const nextByRepo: AppState['detectedWorktreesByRepo'] = {}

  for (const [repoId, result] of Object.entries(detectedWorktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = result.worktrees.map((worktree) => {
      if (worktree.id !== worktreeId || !worktreeRowMatchesMetaHost(worktree, executionHostId)) {
        return worktree
      }
      repoChanged = true
      changed = true
      const next = { ...worktree, ...normalizeWorkspaceAttachmentUpdate(worktree, updates) }
      if (updates.displayNameIsPinned !== undefined) {
        next.displayNameMode = updates.displayNameIsPinned ? 'fixed' : 'automatic'
        if (updates.displayNameIsPinned === false && !updates.displayName?.trim()) {
          const automaticName = branchName(next.branch)
          next.displayName = automaticName || worktree.displayName
        }
      }
      return next
    })
    nextByRepo[repoId] = repoChanged ? { ...result, worktrees: nextWorktrees } : result
  }

  return changed ? nextByRepo : detectedWorktreesByRepo
}

export function folderWorkspaceMatchesHost(
  workspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  executionHostId: ExecutionHostId
): boolean {
  return getRepoExecutionHostId(workspace) === executionHostId
}

export function findKnownWorktreeById(
  state: WorkspaceRecordState & Pick<AppState, 'detectedWorktreesByRepo' | 'floatingWorkspacePath'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined {
  if (isFloatingWorkspaceId(worktreeId)) {
    // The floating workspace has no repo/folder row; mint the same synthetic row the host resolves
    // with, from the host-resolved directory. Before resolution there is no path to answer with.
    const path = state.floatingWorkspacePath
    if (!path || (executionHostId && executionHostId !== LOCAL_EXECUTION_HOST_ID)) {
      return undefined
    }
    if (floatingWorkspaceWorktreeCache?.path !== path) {
      floatingWorkspaceWorktreeCache = { path, worktree: floatingWorkspaceToWorktree(path) }
    }
    return floatingWorkspaceWorktreeCache.worktree
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    const result = resolveQualifiedIndexedFolderWorkspace(
      state,
      workspaceScope.folderWorkspaceId,
      executionHostId
    )
    if (result.kind === 'selected') {
      return getFolderWorkspaceWorktree(result.value.workspace, result.value)
    }
    // Preserve unqualified path access for narrow snapshots.
    if (!executionHostId && (!state.projectGroups || !state.repos)) {
      const rows = selectFolderWorkspaces(state).filter(
        (workspace) => workspace.id === workspaceScope.folderWorkspaceId
      )
      return rows.length === 1 ? getFolderWorkspaceWorktree(rows[0]) : undefined
    }
    return undefined
  }
  const visible = executionHostId
    ? selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: worktreeId, hostId: executionHostId })
      )
    : findFirstIndexedWorktree(selectWorktreesByRepo(state), worktreeId)
  if (visible) {
    return visible
  }
  // Cached index avoids fleet scans per deleted-worktree activity row; same row objects justify restoring the listing row type.
  const detectedCandidates = findIndexedDetectedWorktrees(
    state.detectedWorktreesByRepo,
    worktreeId
  ) as DetectedWorktreeListResult['worktrees']
  return executionHostId
    ? firstDetectedDirectoryForHost(detectedCandidates, executionHostId)
    : detectedCandidates[0]
}

type DetectedDirectoryRow = DetectedWorktreeListResult['worktrees'][number]
const detectedDirectoryIndexes = new WeakMap<
  readonly DetectedDirectoryRow[],
  ReadonlyMap<string, { row: DetectedDirectoryRow; position: number }>
>()

function firstDetectedDirectoryForHost(
  rows: readonly DetectedDirectoryRow[],
  hostId: ExecutionHostId
): DetectedDirectoryRow | undefined {
  if (!rows.length) {
    return undefined
  }
  let index = detectedDirectoryIndexes.get(rows)
  if (!index) {
    const next = new Map<string, { row: DetectedDirectoryRow; position: number }>()
    rows.forEach((row, position) => {
      // Directory matching gives raw logical ownership precedence over physical host spelling.
      const key = row.runtimeOwnerEnvironmentId
        ? `owner\0${row.runtimeOwnerEnvironmentId}`
        : `host\0${row.hostId || LOCAL_EXECUTION_HOST_ID}`
      if (!next.has(key)) {
        next.set(key, { row, position })
      }
    })
    index = next
    detectedDirectoryIndexes.set(rows, index)
  }
  const physical = index.get(`host\0${hostId}`)
  const parsed = parseExecutionHostId(hostId)
  const logical =
    parsed?.kind === 'runtime' ? index.get(`owner\0${parsed.environmentId}`) : undefined
  return logical && (!physical || logical.position < physical.position)
    ? logical.row
    : physical?.row
}

export function getFolderWorkspaceMetaUpdates(
  updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
) {
  const next: Partial<FolderWorkspace> & WorkspaceAttachmentMutation = Object.fromEntries(
    (
      [
        'comment',
        'isArchived',
        'isUnread',
        'isPinned',
        'sortOrder',
        'manualOrder',
        'lastActivityAt',
        'workspaceStatus',
        'createdWithAgent',
        'pendingFirstAgentMessageRename',
        'firstAgentMessageRenameError',
        'diffComments',
        'linkedItems',
        'linkedItemsBase',
        'linkedItemsSelectionChanged',
        'linkedTaskSourceContext'
      ] as const
    )
      .filter((field) => updates[field] !== undefined)
      .map((field) => [field, updates[field]])
  )
  if (updates.displayName !== undefined) {
    next.name = updates.displayName
    next.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename ?? false
    next.firstAgentMessageRenameError =
      updates.firstAgentMessageRenameError === undefined
        ? null
        : updates.firstAgentMessageRenameError
  }
  if (
    updates.comment !== undefined &&
    updates.lastActivityAt === undefined &&
    !ORCA_SIDEBAR_INPUTS_IS_MAIN
  ) {
    next.lastActivityAt = Date.now()
  }
  if (updates.linkedWorkItem !== undefined) {
    next.linkedTask = updates.linkedWorkItem
  }
  return next
}
