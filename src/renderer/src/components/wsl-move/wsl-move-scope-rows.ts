/**
 * What the move dialog shows about its projects, read from the renderer catalog. Main decides what
 * moves; this only names rows, counts what they hold, and maps blockers back to their project.
 */
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type {
  WslMoveBlocker,
  WslMoveRowRef
} from '../../../../shared/wsl-move/wsl-move-driver-types'

export type WslMoveCatalog = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  worktreesByRepo: Record<string, readonly Worktree[]>
  unifiedTabsByWorktree: Record<string, readonly Pick<Tab, 'id' | 'entityId' | 'contentType'>[]>
}

export type WslMoveProjectRow = WslMoveRowRef & { name: string }

export type WslMoveCounts = {
  projects: number
  workspaces: number
  terminals: number
  chats: number
}

// Rule D7: a repo on a Windows drive reached through the distro stays a Windows project.
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-z](\/|$)/i

/** The distro a local folder lives in when it could move to that distro's host; else null. */
export function wslMoveDistroOfPath(path: string): string | null {
  const parsed = parseWslUncPath(path)
  return parsed && !WINDOWS_DRIVE_MOUNT.test(parsed.linuxPath) ? parsed.distro : null
}

/** The added WSL host of a distro, matched as WSL matches names: case-insensitively. */
export function findWslHostForDistro(
  environments: readonly PublicKnownRuntimeEnvironment[],
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

/** The host a local WSL repo could move to, spelled as the host names its distro. */
export function wslMoveTargetForRepo(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>,
  environments: readonly PublicKnownRuntimeEnvironment[]
): string | null {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const distro = wslMoveDistroOfPath(repo.path)
  return distro ? (findWslHostForDistro(environments, distro)?.distro ?? null) : null
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
      name: catalog.folderWorkspaces.find((folder) => folder.id === id)?.name ?? id
    }))
  ]
}

function localWorkspaceKeys(catalog: WslMoveCatalog, ref: WslMoveRowRef): string[] {
  if (ref.kind === 'folder') {
    return [folderWorkspaceKey(ref.id)]
  }
  return (catalog.worktreesByRepo[ref.id] ?? [])
    .filter((worktree) => (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID)
    .map((worktree) => worktree.id)
}

/** Counts of what the selected projects hold here, for the preview's summary line. */
export function wslMoveCounts(
  catalog: WslMoveCatalog,
  selected: readonly WslMoveRowRef[]
): WslMoveCounts {
  const counts: WslMoveCounts = { projects: selected.length, workspaces: 0, terminals: 0, chats: 0 }
  for (const ref of selected) {
    for (const key of localWorkspaceKeys(catalog, ref)) {
      counts.workspaces += 1
      for (const tab of catalog.unifiedTabsByWorktree[key] ?? []) {
        if (tab.contentType === 'terminal') {
          counts.terminals += 1
        } else if (tab.contentType === 'agent-session') {
          counts.chats += 1
        }
      }
    }
  }
  return counts
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
  catalog: Pick<WslMoveCatalog, 'repos' | 'folderWorkspaces'>,
  distro: string
): { repoIds: string[]; folderWorkspaceIds: string[] } {
  const inDistro = (path: string): boolean =>
    wslMoveDistroOfPath(path)?.toLowerCase() === distro.toLowerCase()
  return {
    repoIds: catalog.repos
      .filter(
        (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID && inDistro(repo.path)
      )
      .map((repo) => repo.id),
    folderWorkspaceIds: catalog.folderWorkspaces
      .filter(
        (folder) =>
          (folder.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
          !folder.connectionId &&
          inDistro(folder.folderPath)
      )
      .map((folder) => folder.id)
  }
}
