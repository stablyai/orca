import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { OpenFile } from '@/store/slices/editor'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { dedupePaletteWorktrees } from './palette-repo-resolution'

export function getPaletteOwnershipWorktreeIds(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>
): Pick<Worktree, 'id'>[] {
  return [
    ...dedupePaletteWorktrees(Object.values(state.worktreesByRepo).flat()),
    ...(state.folderWorkspaces ?? []).map((workspace) => ({ id: folderWorkspaceKey(workspace.id) }))
  ]
}

export function findDuplicateIds(items: readonly { id: string }[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.add(item.id)
    }
    seen.add(item.id)
  }
  return duplicates
}

export function findAmbiguousWorktreeIds(
  worktrees: readonly Pick<Worktree, 'id'>[]
): ReadonlySet<string> {
  return findDuplicateIds(worktrees)
}

export function getActiveExecutionHostIdForWorktree(
  state: {
    activeWorktreeId: string | null
    activeWorkspaceExecutionHostId?: ExecutionHostId | null
  },
  worktreeId: string
): ExecutionHostId | undefined {
  return state.activeWorktreeId === worktreeId
    ? (state.activeWorkspaceExecutionHostId ?? LOCAL_EXECUTION_HOST_ID)
    : undefined
}

export function isUnifiedTabOwnedByWorktree(
  tab: Pick<Tab, 'executionHostId' | 'worktreeId'> | undefined,
  worktree: Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>,
  ambiguousWorktreeIds: ReadonlySet<string>
): boolean {
  if (!tab || tab.worktreeId !== worktree.id) {
    return false
  }
  if (tab.executionHostId) {
    return isExecutionHostAliasForWorktree(tab.executionHostId, worktree)
  }
  return !ambiguousWorktreeIds.has(worktree.id)
}

export function isOpenFileOwnedByWorktree(
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
  >,
  worktree: Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>
): boolean {
  if (file.worktreeId !== worktree.id) {
    return false
  }
  const operationHost = file.operationProvenance?.generation.route.executionHostId
  if (operationHost) {
    return isExecutionHostAliasForWorktree(operationHost, worktree)
  }
  if (file.externalSshTargetId) {
    return isExecutionHostAliasForWorktree(toSshExecutionHostId(file.externalSshTargetId), worktree)
  }
  if (file.runtimeEnvironmentId) {
    return isExecutionHostAliasForWorktree(
      toRuntimeExecutionHostId(file.runtimeEnvironmentId),
      worktree
    )
  }
  return isExecutionHostAliasForWorktree(LOCAL_EXECUTION_HOST_ID, worktree)
}

export function hasOpenFileExecutionHostEvidence(
  file: Pick<OpenFile, 'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId'>
): boolean {
  return Boolean(file.operationProvenance || file.externalSshTargetId || file.runtimeEnvironmentId)
}

export function getUnifiedTabPaletteExecutionHostId(
  tab: Pick<Tab, 'executionHostId'> | undefined,
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): ExecutionHostId | undefined {
  if (!tab) {
    return worktree.hostId
  }
  if (tab.executionHostId && isExecutionHostAliasForWorktree(tab.executionHostId, worktree)) {
    return tab.executionHostId
  }
  return worktree.hostId
}
