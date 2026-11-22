/**
 * Local projects a WSL host now owns (owner decision, option C): their existing native chats stay
 * on this computer, listed under a read-only entry. Their terminals, editors and browser tabs live
 * on the host now, so only `agent-session` tabs of these workspaces survive here.
 *
 * The host's own rows carry the same project ids, so a workspace counts as moved only when it is
 * not one the catalog lists: a listed worktree or folder of that id is the host's.
 */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  wslMovedProjectKey,
  type WslMovedProject
} from '../../../../shared/wsl-move/wsl-moved-project'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

import {
  type ExecutionHostId,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'
import { getFolderWorkspaceWorktreeHostId } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { isWebClientLocation } from '../../app-shell/platform/web-client-location'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'
import { findFirstIndexedWorktree } from '../../lib/workspace/ownership/worktree-runtime-owner-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../workspaces/catalog/workspace-record-fields'

type MovedCatalog = Pick<AppState, 'wslMovedProjects' | 'worktreesByRepo' | 'folderWorkspaces'>

export async function fetchWslMovedProjects(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Promise<void> {
  const list = window.api?.repos?.listWslMoved
  if (typeof list !== 'function') {
    return
  }
  try {
    const projects = await list()
    set((state) =>
      sameMovedProjects(state.wslMovedProjects, projects) ? state : { wslMovedProjects: projects }
    )
    // Desktop only: a web client's list is always empty, and its prune would drop the desktop's keys.
    if (!isWebClientLocation()) {
      get().retainHiddenWslMovedProjects(projects)
    }
  } catch (error) {
    // Without the list the moved chats stay hidden, as before this entry existed; nothing breaks.
    console.warn('[wsl-move] Could not list moved projects:', error)
  }
}

function sameMovedProjects(
  left: readonly WslMovedProject[],
  right: readonly WslMovedProject[]
): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const other = right[index]
      return (
        project.kind === other.kind &&
        project.id === other.id &&
        project.displayName === other.displayName &&
        project.path === other.path &&
        project.distro === other.distro
      )
    })
  )
}

/** The moved project a session key names by id alone, before the catalog says whose it is. */
export function movedProjectForKey(
  projects: readonly WslMovedProject[],
  workspaceKey: string
): WslMovedProject | null {
  if (projects.length === 0) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceKey)
  if (scope?.type === 'folder') {
    const { folderWorkspaceId } = scope
    return projects.find((p) => p.kind === 'folder' && p.id === folderWorkspaceId) ?? null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceKey
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return projects.find((p) => p.kind === 'repo' && p.id === repoId) ?? null
}

/** The moved project a workspace belongs to; null for every listed workspace, the host's included. */
export function findWslMovedProjectForWorkspace(
  state: MovedCatalog,
  workspaceKey: string
): WslMovedProject | null {
  const project = movedProjectForKey(state.wslMovedProjects, workspaceKey)
  if (!project) {
    return null
  }
  if (project.kind === 'folder') {
    return selectFolderWorkspaces(state).some((folder) => folder.id === project.id) ? null : project
  }
  const scope = parseWorkspaceKey(workspaceKey)
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceKey
  return findFirstIndexedWorktree(selectWorktreesByRepo(state), worktreeId) ? null : project
}

/**
 * The moved project a local automation belongs to: its copy here stays as it was (undo brings it
 * back), but the host runs it now and this computer never does. Null for any other automation.
 */
export function wslMovedProjectForAutomation(
  projects: readonly WslMovedProject[],
  automation: { executionTargetType: string; projectId: string; workspaceId?: string | null }
): WslMovedProject | null {
  if (projects.length === 0 || automation.executionTargetType !== 'local') {
    return null
  }
  const folder = automation.workspaceId ? parseWorkspaceKey(automation.workspaceId) : null
  if (folder?.type === 'folder') {
    return movedProjectForKey(projects, automation.workspaceId ?? '')
  }
  return projects.find((p) => p.kind === 'repo' && p.id === automation.projectId) ?? null
}

export function isWslMovedChatTab(tab: Pick<Tab, 'contentType'>): boolean {
  return tab.contentType === 'agent-session'
}

/**
 * This computer's session keys of moved projects, read before the catalog decides anything: a
 * paired host's partition is that host's own workspace, never the retained local one.
 */
export function collectWslMovedWorkspaceKeysFromSession(
  session: Pick<WorkspaceSessionState, 'unifiedTabs'>,
  projects: readonly WslMovedProject[],
  runtimeHostIdByWorkspaceSessionKey?: Readonly<Record<string, ExecutionHostId>>
): string[] {
  return Object.keys(session.unifiedTabs ?? {}).filter(
    (key) =>
      movedProjectForKey(projects, key) !== null &&
      parseExecutionHostId(runtimeHostIdByWorkspaceSessionKey?.[key])?.kind !== 'runtime'
  )
}

/**
 * Every moved project, in list order, with its workspaces holding chats. A project without chats
 * still lists: its entry is the only way to "Use on this computer again".
 */
export function selectWslMovedChatWorkspaces(
  state: MovedCatalog & Pick<AppState, 'unifiedTabsByWorktree'>
): { project: WslMovedProject; workspaces: { key: string; chats: Tab[] }[] }[] {
  if (state.wslMovedProjects.length === 0) {
    return []
  }
  const byProject = new Map<WslMovedProject, { key: string; chats: Tab[] }[]>()
  for (const [key, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const chats = tabs.filter(isWslMovedChatTab)
    const project = chats.length > 0 ? findWslMovedProjectForWorkspace(state, key) : null
    if (project) {
      byProject.set(project, [...(byProject.get(project) ?? []), { key, chats }])
    }
  }
  return state.wslMovedProjects.map((project) => ({
    project,
    workspaces: byProject.get(project) ?? []
  }))
}

type WslMovedEntry = ReturnType<typeof selectWslMovedChatWorkspaces>[number]
type HostRowCatalog = Pick<AppState, 'repos' | 'runtimeEnvironments' | 'projectGroups'> & {
  folderWorkspaces: readonly FolderWorkspace[]
}

/** Whether the project's host lists it, so that row's menu still offers "Use on this computer again". */
export function wslMovedProjectHasHostRow(
  catalog: HostRowCatalog,
  project: WslMovedProject
): boolean {
  const hostIds =
    project.kind === 'repo'
      ? catalog.repos.filter((row) => row.id === project.id).map(getRepoExecutionHostId)
      : selectFolderWorkspaces(catalog)
          .filter((row) => row.id === project.id)
          .map((row) => getFolderWorkspaceHostId(row, catalog.projectGroups))
  return hostIds.some(
    (hostId) => wslMovedProjectOnHost(project, catalog.runtimeEnvironments, hostId) !== null
  )
}

/**
 * The host owning the clicked row, resolved as `wslMovedProjectHasHostRow` does: a folder's comes
 * from its record (its project group's host when unstamped), picked by the row's own identity.
 */
export function wslMovedRowOwnerHostId(
  catalog: Pick<HostRowCatalog, 'folderWorkspaces' | 'projectGroups'>,
  row: Pick<Worktree, 'id' | 'hostId'>
): string | null {
  const scope = parseWorkspaceKey(row.id)
  if (scope?.type !== 'folder') {
    return row.hostId ?? null
  }
  const folder = selectFolderWorkspaces(catalog).find(
    (candidate) =>
      candidate.id === scope.folderWorkspaceId &&
      (!row.hostId || getFolderWorkspaceWorktreeHostId(candidate) === row.hostId)
  )
  return folder ? getFolderWorkspaceHostId(folder, catalog.projectGroups) : null
}

/**
 * Hideable: no chats (the entry is the only way to them) and a host row whose menu keeps undo;
 * without that row, as after removing the host, the entry is the only way back.
 */
export function canHideWslMovedEntry(catalog: HostRowCatalog, entry: WslMovedEntry): boolean {
  return entry.workspaces.length === 0 && wslMovedProjectHasHostRow(catalog, entry.project)
}

export function selectListedWslMovedChatWorkspaces(
  groups: readonly WslMovedEntry[],
  hiddenKeys: readonly string[],
  catalog: HostRowCatalog
): readonly WslMovedEntry[] {
  if (hiddenKeys.length === 0) {
    return groups
  }
  const hidden = new Set(hiddenKeys)
  return groups.filter(
    (entry) =>
      !hidden.has(wslMovedProjectKey(entry.project)) || !canHideWslMovedEntry(catalog, entry)
  )
}

/** The moved project a row on a WSL host stands for: its id, on the host of the distro it moved to. */
export function wslMovedProjectOnHost(
  project: WslMovedProject | null,
  environments: readonly PublicKnownRuntimeEnvironment[],
  hostId: string | null | undefined
): WslMovedProject | null {
  const host = project ? parseExecutionHostId(hostId) : null
  if (!project || host?.kind !== 'runtime') {
    return null
  }
  const environment = environments.find((candidate) => candidate.id === host.environmentId)
  return environment &&
    isWslHostRuntimeEnvironment(environment) &&
    environment.orcadDeployment.distro.toLowerCase() === project.distro.toLowerCase()
    ? project
    : null
}

export type WslMovedWorkspaceSurface = { id: string; path: string }

/**
 * The workbench mounts only catalog workspaces, so a moved one needs its own surface to show its
 * chats. Serialized so tab churn elsewhere returns an equal string and re-projects nothing.
 */
export function selectWslMovedSurfacesKey(
  state: MovedCatalog & Pick<AppState, 'unifiedTabsByWorktree'>
): string {
  if (state.wslMovedProjects.length === 0) {
    return ''
  }
  const surfaces: WslMovedWorkspaceSurface[] = []
  for (const key of Object.keys(state.unifiedTabsByWorktree)) {
    const project = findWslMovedProjectForWorkspace(state, key)
    if (project) {
      const path =
        project.kind === 'folder'
          ? project.path
          : (splitWorktreeIdForFilesystem(key)?.worktreePath ?? project.path)
      surfaces.push({ id: key, path })
    }
  }
  return surfaces.length > 0 ? JSON.stringify(surfaces) : ''
}

export function parseWslMovedSurfacesKey(surfacesKey: string): WslMovedWorkspaceSurface[] {
  if (!surfacesKey) {
    return []
  }
  const parsed: unknown = JSON.parse(surfacesKey)
  return Array.isArray(parsed)
    ? parsed.filter(
        (entry): entry is WslMovedWorkspaceSurface =>
          typeof entry?.id === 'string' && typeof entry?.path === 'string'
      )
    : []
}
