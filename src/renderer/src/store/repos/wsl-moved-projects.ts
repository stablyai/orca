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
import type { Tab } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree/id'
import { findWorktreeById } from '../slices/worktree-helpers'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../workspace-record-selectors'

type MovedCatalog = Pick<AppState, 'wslMovedProjects' | 'worktreesByRepo' | 'folderWorkspaces'>

export async function fetchWslMovedProjects(
  set: Parameters<StateCreator<AppState>>[0]
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
  return findWorktreeById(selectWorktreesByRepo(state), worktreeId) ? null : project
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
