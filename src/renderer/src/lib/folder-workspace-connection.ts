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
  switch (host.kind) {
    case 'ssh':
      return host.targetId
    // Why the server's own target: like a project row there (`getRepoSshConnectionId`), so its
    // SSH state is read inside that server rather than reading as local.
    case 'runtime':
      return host.sshTargetId
    case 'local':
      return null
    case 'missing':
    case 'ambiguous':
      return undefined
  }
}
