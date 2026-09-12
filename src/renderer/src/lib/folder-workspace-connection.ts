import type { Repo } from '../../../shared/repo-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'

export type FolderWorkspaceConnectionState = FolderWorkspaceHostState

export function getFolderWorkspaceCandidateRepos(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): Repo[] {
  return findFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
}

/** Resolves an explicit host directly; without one, `undefined` means gone or ambiguous. */
export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): string | null | undefined {
  const selectedHost = parseExecutionHostId(executionHostId)
  if (selectedHost) {
    return selectedHost.kind === 'ssh' ? selectedHost.targetId : null
  }
  const host = resolveFolderWorkspaceHost(state, folderWorkspaceId)
  if (host.kind === 'ssh') {
    return host.targetId
  }
  return host.kind === 'local' ? null : undefined
}
