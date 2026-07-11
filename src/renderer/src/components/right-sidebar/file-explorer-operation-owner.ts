import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getSettingsForWorktreeRuntimeOwner
} from '@/lib/worktree-runtime-owner'
import type { FileExplorerOperationOwner } from './file-explorer-types'

export type FileExplorerOperationRoute = {
  settings: { activeRuntimeEnvironmentId: string | null }
  connectionId?: string
}

type FileExplorerOwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function getFileExplorerOperationOwnerFromState(
  state: FileExplorerOwnerState,
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  const parsedWorkspace = worktreeId ? parseWorkspaceKey(worktreeId) : null
  if (worktreeId && parsedWorkspace?.type !== 'folder') {
    const exactHostIds = getExactWorktreeHostIds(state, worktreeId)
    if (exactHostIds.size > 1) {
      return { kind: 'unresolved' }
    }
    const exactHostId = exactHostIds.values().next().value
    if (exactHostId) {
      return operationOwnerFromHostId(exactHostId)
    }

    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoHostIds = new Set(
      state.repos.filter((repo) => repo.id === repoId).map(getRepoExecutionHostId)
    )
    if (repoHostIds.size > 1) {
      return { kind: 'unresolved' }
    }
  }

  const connectionId = getConnectionIdFromState(state, worktreeId ?? null)
  const explicitRuntimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: global runtime focus is not ownership evidence while SSH/local
  // metadata is unresolved; destructive actions must wait for explicit provenance.
  if (connectionId === undefined && explicitRuntimeEnvironmentId === null) {
    return { kind: 'unresolved' }
  }
  const settings = getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  // Why: inferred SSH ownership outranks global runtime focus, but an explicit
  // workspace runtime still owns its files.
  const runtimeEnvironmentId =
    connectionId && explicitRuntimeEnvironmentId === null
      ? null
      : settings.activeRuntimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', environmentId: runtimeEnvironmentId }
  }
  if (connectionId === undefined) {
    return { kind: 'unresolved' }
  }
  return connectionId ? { kind: 'ssh', connectionId } : { kind: 'local' }
}

export function getFileExplorerOperationOwner(
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  return getFileExplorerOperationOwnerFromState(useAppStore.getState(), worktreeId)
}

export function getFileExplorerOperationRoute(
  owner: FileExplorerOperationOwner
): FileExplorerOperationRoute | null {
  switch (owner.kind) {
    case 'local':
      return { settings: { activeRuntimeEnvironmentId: null } }
    case 'ssh':
      return {
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: owner.connectionId
      }
    case 'runtime':
      return { settings: { activeRuntimeEnvironmentId: owner.environmentId } }
    case 'unresolved':
      return null
  }
}

export function getFileExplorerOwnerUnresolvedMessage(): string {
  return translate(
    'auto.components.right.sidebar.fileExplorerOperationOwner.unresolved',
    "Couldn't determine which host owns this workspace. Check the connection and try again."
  )
}

function getExactWorktreeHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): Set<ExecutionHostId> {
  const hostIds = new Set<ExecutionHostId>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.id === worktreeId && worktree.hostId) {
        hostIds.add(worktree.hostId)
      }
    }
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    for (const worktree of result.worktrees) {
      if (worktree.id === worktreeId && worktree.hostId) {
        hostIds.add(worktree.hostId)
      }
    }
  }
  return hostIds
}

function operationOwnerFromHostId(hostId: ExecutionHostId): FileExplorerOperationOwner {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return { kind: 'local' }
    case 'ssh':
      return { kind: 'ssh', connectionId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', environmentId: parsed.environmentId }
    case undefined:
      return { kind: 'unresolved' }
  }
}
