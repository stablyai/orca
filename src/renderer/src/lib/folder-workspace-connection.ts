import type { Repo } from '../../../shared/repo-types'
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

/** Legacy tri-state view of the shared resolution: `undefined` = gone or ambiguous. */
export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): string | null | undefined {
  const host = resolveFolderWorkspaceHost(state, folderWorkspaceId)
  switch (host.kind) {
    case 'ssh':
      return host.targetId
    // Use the owning server’s SSH target so its status resolves there rather than reading as local.
    case 'runtime':
      return host.sshTargetId
    case 'local':
      return null
    case 'missing':
    case 'ambiguous':
      return undefined
  }
}
