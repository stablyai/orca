// The workspaces a server's checklist names on a host: its repos by repo id, its folder workspaces as
// `folder:<id>`. Never a worktree, so a choice holds for every worktree of a repo.
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'

export type McpHostWorkspace = { key: string; name: string; kind: 'repo' | 'folder' }

export function useMcpHostWorkspaces(target: RuntimeClientTarget): McpHostWorkspace[] {
  const hostId = getRuntimeTargetHostId(target)
  const repos = useAppStore((state) => state.repos)
  const folders = useAppStore(selectFolderWorkspaces)
  return useMemo(
    () => [
      ...repos
        .filter((repo) => getRepoExecutionHostId(repo) === hostId)
        .map((repo): McpHostWorkspace => ({ key: repo.id, name: repo.displayName, kind: 'repo' })),
      ...folders
        .filter((folder) => !folder.isArchived && getRepoExecutionHostId(folder) === hostId)
        .map((folder): McpHostWorkspace => ({
          key: folderWorkspaceKey(folder.id),
          name: folder.name,
          kind: 'folder'
        }))
    ],
    [repos, folders, hostId]
  )
}
