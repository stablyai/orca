import type { Repo } from '../../../shared/repo-types'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

export type FolderWorkspaceConnectionState = FolderWorkspaceHostState

type ConnectionsByRepos = WeakMap<
  FolderWorkspaceHostState['repos'],
  Map<string, FolderWorkspaceHost>
>
// Retained folder tab strips read on every store write; host inference needs only these catalogs.
const folderConnections = new WeakMap<
  FolderWorkspaceHostState['folderWorkspaces'],
  WeakMap<FolderWorkspaceHostState['projectGroups'], ConnectionsByRepos>
>()

function readFolderWorkspaceHost(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): FolderWorkspaceHost {
  const folders = selectFolderWorkspaces(state)
  if (!folders || !state.projectGroups || !state.repos) {
    return resolveFolderWorkspaceHost(state, folderWorkspaceId)
  }
  let byGroups = folderConnections.get(folders)
  if (!byGroups) {
    byGroups = new WeakMap()
    folderConnections.set(folders, byGroups)
  }
  let byRepos = byGroups.get(state.projectGroups)
  if (!byRepos) {
    byRepos = new WeakMap()
    byGroups.set(state.projectGroups, byRepos)
  }
  let byFolderId = byRepos.get(state.repos)
  if (!byFolderId) {
    byFolderId = new Map()
    byRepos.set(state.repos, byFolderId)
  }
  const cached = byFolderId.get(folderWorkspaceId)
  if (cached) {
    return cached
  }
  const host = resolveFolderWorkspaceHost(state, folderWorkspaceId)
  // Missing IDs are unbounded; keep only answers for this immutable catalog's folders.
  if (host.kind !== 'missing') {
    byFolderId.set(folderWorkspaceId, host)
  }
  return host
}

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
  const host = readFolderWorkspaceHost(state, folderWorkspaceId)
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
