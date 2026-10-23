import { ptySessionIdentity, type PtyListedSession } from '../../../../shared/pty-listed-session'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import { projectGroupIdFromRepoId } from '../../../../shared/folder-workspace-worktree'
import { makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'
import {
  deriveWorktreeNameFromWorktreeId,
  resolveDaemonSessionLabel
} from './resource-session-labels'

export type ResourcePtyRow = {
  session: PtyListedSession
  identity: string
  label: string
  sortName: string
  workspace: string | null
  projectId: string
  project: string | null
  workspaceId: string | null
  tabId: string | null
  paneKey: string | null
  binding: 'bound' | 'unbound' | 'pending'
}

export type ResourcePtyGroup = {
  id: string
  name: string | null
  workspaces: { id: string; name: string | null; rows: ResourcePtyRow[] }[]
}

export function buildResourcePtyRows(args: {
  sessions: readonly PtyListedSession[]
  bindings: ResourceSessionBindingInputs
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}): ResourcePtyRow[] {
  const repoById = new Map(args.repos.map((repo) => [repo.id, repo]))
  const localRepos = new Map(
    args.repos
      .filter((repo) => getRepoExecutionHostId(repo) === 'local')
      .map((repo) => [repo.id, repo])
  )
  const worktrees = new Map(
    args.worktrees
      .filter(
        (workspace) =>
          getWorktreeExecutionHostId(
            workspace,
            workspace.repoId ? repoById.get(workspace.repoId) : undefined
          ) === 'local'
      )
      .map((workspace) => [workspace.id, workspace])
  )
  const remoteIds = new Set(
    args.worktrees
      .filter(
        (workspace) =>
          getWorktreeExecutionHostId(
            workspace,
            workspace.repoId ? repoById.get(workspace.repoId) : undefined
          ) !== 'local'
      )
      .map((workspace) => workspace.id)
  )
  const tabsByWorktree = Object.fromEntries(
    Object.entries(args.bindings.tabsByWorktree).filter(([id]) => !remoteIds.has(id))
  )
  const localTabIds = new Set(
    Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const ptyIdsByTabId = Object.fromEntries(
    Object.entries(args.bindings.ptyIdsByTabId).filter(([id]) => localTabIds.has(id))
  )
  const terminalLayoutsByTabId = Object.fromEntries(
    Object.entries(args.bindings.terminalLayoutsByTabId ?? {}).filter(([id]) => localTabIds.has(id))
  )
  const bindings = buildResourceSessionBindingIndex({
    ...args.bindings,
    tabsByWorktree,
    deferredSshSessionIdsByTabId: {},
    ptyIdsByTabId,
    terminalLayoutsByTabId
  })
  const projectGroups = new Map(
    args.projectGroups
      .filter(
        (group) =>
          !group.connectionId && (!group.executionHostId || group.executionHostId === 'local')
      )
      .map((group) => [group.id, group.name])
  )
  const paneKeys = new Map<string, string>()
  for (const [tabId, layout] of Object.entries(args.bindings.terminalLayoutsByTabId ?? {})) {
    if (!localTabIds.has(tabId)) {
      continue
    }
    for (const [leafId, id] of Object.entries(layout.ptyIdsByLeafId ?? {})) {
      if (
        id &&
        bindings.ptyIdToTabId.get(id) === tabId &&
        isTerminalLeafId(leafId) &&
        !paneKeys.has(id)
      ) {
        paneKeys.set(id, makePaneKey(tabId, leafId))
      }
    }
  }
  const sessions = new Map(args.sessions.map((session) => [ptySessionIdentity(session), session]))
  const countsById = new Map<string, number>()
  for (const session of sessions.values()) {
    countsById.set(session.id, (countsById.get(session.id) ?? 0) + 1)
  }
  return [...sessions.values()].map((session): ResourcePtyRow => {
    const routeUnknown = session.routed === undefined && (countsById.get(session.id) ?? 0) > 1
    const tabId =
      session.routed === false || routeUnknown
        ? null
        : (bindings.ptyIdToTabId.get(session.id) ?? null)
    const workspaceId =
      (tabId && bindings.tabIdToWorktreeId.get(tabId)) || session.worktreeId || null
    const workspace = workspaceId ? worktrees.get(workspaceId) : undefined
    const workspaceName = workspace
      ? workspace.displayName?.trim() || deriveWorktreeNameFromWorktreeId(workspace.id)
      : null
    const tab =
      workspaceId && tabId
        ? bindings.tabsByIdByWorktree.get(workspaceId)?.get(tabId)?.tab
        : undefined
    const groupId = projectGroupIdFromRepoId(workspace?.repoId)
    const project = workspace?.repoId
      ? groupId
        ? projectGroups.get(groupId)
        : localRepos.get(workspace.repoId)?.displayName
      : undefined
    const label =
      !tabId && session.title.trim()
        ? session.title.trim()
        : resolveDaemonSessionLabel(session, workspaceId, tabId, args, bindings)
    return {
      session,
      identity: ptySessionIdentity(session),
      label,
      sortName: tab?.customTitle?.trim() || tab?.defaultTitle?.trim() || session.id,
      workspace: workspaceName,
      workspaceId: workspace?.id ?? null,
      projectId: project ? (workspace?.repoId ?? '') : '',
      project: project ?? null,
      tabId,
      paneKey: tabId ? (paneKeys.get(session.id) ?? null) : null,
      binding:
        !args.bindings.workspaceSessionReady || routeUnknown
          ? 'pending'
          : tabId
            ? 'bound'
            : 'unbound'
    }
  })
}

export function groupResourcePtyRows(rows: readonly ResourcePtyRow[]): ResourcePtyGroup[] {
  const projects = new Map<
    string,
    { group: ResourcePtyGroup; workspaces: Map<string, ResourcePtyGroup['workspaces'][number]> }
  >()
  for (const row of rows) {
    let project = projects.get(row.projectId)
    if (!project) {
      project = {
        group: { id: row.projectId, name: row.project, workspaces: [] },
        workspaces: new Map()
      }
      projects.set(row.projectId, project)
    }
    const workspaceId = row.workspaceId ?? ''
    let workspace = project.workspaces.get(workspaceId)
    if (!workspace) {
      workspace = { id: workspaceId, name: row.workspace, rows: [] }
      project.workspaces.set(workspaceId, workspace)
      project.group.workspaces.push(workspace)
    }
    workspace.rows.push(row)
  }
  const groups = [...projects.values()].map(({ group }) => group)
  for (const group of groups) {
    group.workspaces.sort(
      (a, b) =>
        (a.name?.trim().toLocaleLowerCase() ?? '\uffff').localeCompare(
          b.name?.trim().toLocaleLowerCase() ?? '\uffff'
        ) || a.id.localeCompare(b.id)
    )
    for (const workspace of group.workspaces) {
      workspace.rows.sort(
        (a, b) => a.sortName.localeCompare(b.sortName) || a.session.id.localeCompare(b.session.id)
      )
    }
  }
  return groups.sort(
    (a, b) =>
      (a.name?.trim().toLocaleLowerCase() ?? '\uffff').localeCompare(
        b.name?.trim().toLocaleLowerCase() ?? '\uffff'
      ) || a.id.localeCompare(b.id)
  )
}
