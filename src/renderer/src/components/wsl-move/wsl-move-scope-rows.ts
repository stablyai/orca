/**
 * What the move dialog shows about its projects, read from the renderer catalog. Main decides what
 * moves; this only names rows, counts what they hold, and maps blockers back to their project.
 */
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { wslHostMovableDistroOfPath } from '../../../../shared/file-access/wsl-paths'
import type {
  WslMoveBlocker,
  WslMoveRowRef,
  WslMoveScopeCounts
} from '../../../../shared/wsl-move/wsl-move-driver-types'

export type WslMoveCatalog = {
  repos: readonly Repo[]
  folders: readonly FolderWorkspace[]
  unifiedTabsByWorktree: Record<string, readonly Pick<Tab, 'id' | 'entityId' | 'contentType'>[]>
}

export type WslMoveProjectRow = WslMoveRowRef & { name: string }

export type WslMoveCounts = WslMoveScopeCounts & { projects: number }

/** The distro a local folder lives in when it could move to that distro's host; else null. */
export const wslMoveDistroOfPath = wslHostMovableDistroOfPath

/** The added WSL host of a distro, matched as WSL matches names: case-insensitively. */
export function findWslHostForDistro(
  environments: readonly Pick<PublicKnownRuntimeEnvironment, 'name' | 'orcadDeployment'>[],
  distro: string
): { distro: string; name: string } | null {
  const wanted = distro.toLowerCase()
  for (const environment of environments) {
    if (
      isWslHostRuntimeEnvironment(environment) &&
      environment.orcadDeployment.distro.toLowerCase() === wanted
    ) {
      return { distro: environment.orcadDeployment.distro, name: environment.name }
    }
  }
  return null
}

function localRepo(catalog: WslMoveCatalog, id: string): Repo | undefined {
  return catalog.repos.find(
    (repo) => repo.id === id && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  )
}

export function wslMoveProjectRows(
  catalog: WslMoveCatalog,
  repoIds: readonly string[],
  folderWorkspaceIds: readonly string[]
): WslMoveProjectRow[] {
  return [
    ...repoIds.map((id) => ({
      kind: 'repo' as const,
      id,
      name: localRepo(catalog, id)?.displayName ?? id
    })),
    ...folderWorkspaceIds.map((id) => ({
      kind: 'folder' as const,
      id,
      name: catalog.folders.find((folder) => folder.id === id)?.name ?? id
    }))
  ]
}

function projectOfWorkspaceKey(key: string): WslMoveRowRef {
  const scope = parseWorkspaceKey(key)
  if (scope?.type === 'folder') {
    return { kind: 'folder', id: scope.folderWorkspaceId }
  }
  return {
    kind: 'repo',
    id: getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : key)
  }
}

/**
 * The projects a blocker names, for "Skip project". Pane keys resolve through the tab that holds
 * them; automation runs and dispatches name no tab, so they resolve to nothing here.
 */
export function wslMoveBlockerProjects(
  catalog: WslMoveCatalog,
  blocker: WslMoveBlocker,
  candidates: readonly WslMoveRowRef[]
): WslMoveRowRef[] {
  const found = new Map<string, WslMoveRowRef>()
  for (const id of blocker.ids) {
    const tabId = parsePaneKey(id)?.tabId
    if (!tabId) {
      continue
    }
    for (const [key, tabs] of Object.entries(catalog.unifiedTabsByWorktree)) {
      if (tabs.some((tab) => tab.entityId === tabId || tab.id === tabId)) {
        const ref = projectOfWorkspaceKey(key)
        if (candidates.some((c) => c.kind === ref.kind && c.id === ref.id)) {
          found.set(`${ref.kind}:${ref.id}`, ref)
        }
      }
    }
  }
  return [...found.values()]
}

/**
 * Projects of the distro as this window's catalog lists them. Only the fallback for listing
 * checkboxes when main refused the whole-distro preview for a reason a smaller selection may fix.
 */
export function wslMoveCatalogCandidates(
  catalog: Pick<WslMoveCatalog, 'repos' | 'folders'>,
  distro: string
): { repoIds: string[]; folderWorkspaceIds: string[] } {
  const inDistro = (path: string): boolean =>
    wslMoveDistroOfPath(path)?.toLowerCase() === distro.toLowerCase()
  return {
    repoIds: catalog.repos
      .filter((repo) => isLocalRepo(repo) && inDistro(repo.path))
      .map((repo) => repo.id),
    folderWorkspaceIds: catalog.folders
      .filter((folder) => isLocalFolder(folder) && inDistro(folder.folderPath))
      .map((folder) => folder.id)
  }
}

/** The local project holding a workspace, and the distro whose host it could move to. */
export function wslMoveProjectOfWorkspace(
  catalog: {
    repos: readonly Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>[]
    folders: readonly Pick<
      FolderWorkspace,
      'id' | 'folderPath' | 'connectionId' | 'executionHostId'
    >[]
  },
  workspaceKey: string
): { ref: WslMoveRowRef; distro: string } | null {
  const ref = projectOfWorkspaceKey(workspaceKey)
  const path =
    ref.kind === 'repo'
      ? catalog.repos.find((repo) => repo.id === ref.id && isLocalRepo(repo))?.path
      : catalog.folders.find((folder) => folder.id === ref.id && isLocalFolder(folder))?.folderPath
  const distro = path ? wslMoveDistroOfPath(path) : null
  return distro ? { ref, distro } : null
}

function isLocalRepo(repo: Pick<Repo, 'connectionId' | 'executionHostId'>): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

function isLocalFolder(folder: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>): boolean {
  return (
    (folder.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
    !folder.connectionId
  )
}
