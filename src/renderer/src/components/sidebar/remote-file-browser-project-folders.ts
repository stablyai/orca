import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { Repo } from '../../../../shared/repo-types'
import { isDrivePath } from './remote-file-browser-drive-paths'
import { parentPath } from './remote-file-browser-helpers'

export type RemoteFileBrowserHost = { targetId?: string; runtimeEnvironmentId?: string }

const MAX_PROJECT_FOLDERS = 3

type ProjectRepo = Pick<Repo, 'path' | 'addedAt' | 'connectionId' | 'executionHostId'>

// A server's nested SSH target and the server's own disk are different filesystems.
function isRepoOnBrowserHost(repo: ProjectRepo, host: RemoteFileBrowserHost): boolean {
  const owner = parseExecutionHostId(getRepoExecutionHostId(repo))
  const runtimeEnvironmentId = owner?.kind === 'runtime' ? owner.environmentId : undefined
  return (
    runtimeEnvironmentId === host.runtimeEnvironmentId &&
    (getRepoSshConnectionId(repo) ?? undefined) === host.targetId
  )
}

/** Folders holding the projects already added on this host, most projects first. */
export function remoteFileBrowserProjectFolders(
  repos: readonly ProjectRepo[],
  host: RemoteFileBrowserHost,
  currentPath: string
): string[] {
  const currentKey = normalizeRuntimePathForComparison(currentPath)
  const folders = new Map<string, { path: string; projectCount: number; lastAddedAt: number }>()
  for (const repo of repos) {
    const drivePath = isDrivePath(repo.path)
    if ((!drivePath && !repo.path.startsWith('/')) || !isRepoOnBrowserHost(repo, host)) {
      continue
    }
    const folderPath = parentPath(repo.path, drivePath ? 'win32' : 'posix')
    const key = normalizeRuntimePathForComparison(folderPath)
    if (key === currentKey) {
      continue
    }
    const folder = folders.get(key)
    if (folder) {
      folder.projectCount += 1
      folder.lastAddedAt = Math.max(folder.lastAddedAt, repo.addedAt)
    } else {
      folders.set(key, { path: folderPath, projectCount: 1, lastAddedAt: repo.addedAt })
    }
  }
  return [...folders.values()]
    .sort((a, b) => b.projectCount - a.projectCount || b.lastAddedAt - a.lastAddedAt)
    .slice(0, MAX_PROJECT_FOLDERS)
    .map((folder) => folder.path)
}
