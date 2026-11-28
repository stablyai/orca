import {
  ptySessionIdentity,
  type PtyListedSession
} from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { projectGroupIdFromRepoId } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  makePaneKey,
  isTerminalLeafId,
  parsePaneKey
} from '../../../../../../shared/workspace-layout/stable-pane-id'
import { findRegisteredTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { getTerminalTab } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { recentStamp } from '../../../../../../shared/sidebar-list/sorting/stamp-order'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from '../workspace-attribution/resource-session-bindings'
import {
  deriveWorktreeNameFromWorktreeId,
  resolveDaemonSessionLabel
} from '../workspace-attribution/resource-session-labels'

export type ResourcePtyRow = {
  session: PtyListedSession
  identity: string
  label: string
  usesRuntimeTitle: boolean
  sortName: string
  lastActivityAt: number
  workspace: string | null
  project: string | null
  workspaceId: string | null
  workspacePath: string | null
  tabId: string | null
  paneKey: string | null
  binding: 'bound' | 'unbound' | 'pending'
}

/** One line in the PTYs tab: every PTY without a tab, or one workspace's PTYs. */
export type ResourcePtyGroup = {
  key: string
  kind: 'unbound' | 'workspace'
  name: string | null
  rows: ResourcePtyRow[]
}

export function resourcePtyProcessBaseName(process: string | undefined): string {
  return (
    process
      ?.trim()
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  )
}

export function resourcePtyRowLabel(
  row: ResourcePtyRow,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  liveTabs: ResourceSessionBindingInputs['tabsByWorktree'],
  layouts: ResourceSessionBindingInputs['terminalLayoutsByTabId']
): string {
  if (!row.usesRuntimeTitle || !row.tabId) {
    return row.label
  }
  const leafId = row.paneKey ? parsePaneKey(row.paneKey)?.leafId : undefined
  if (leafId) {
    const mounted = findRegisteredTerminalTab(row.tabId, row.workspaceId ?? undefined)?.tab
    const paneId = mounted?.getManager()?.getNumericIdForLeaf(leafId)
    const title =
      paneId != null && mounted?.getPtyIdForPane(paneId) === row.session.id
        ? runtimePaneTitlesByTabId[row.tabId]?.[paneId]
        : undefined
    const paneTitle = title?.trim() || layouts?.[row.tabId]?.titlesByLeafId?.[leafId]?.trim()
    if (paneTitle) {
      return paneTitle
    }
  }
  const tab = getTerminalTab(liveTabs, row.tabId)
  return tab?.defaultTitle?.trim() || tab?.title?.trim() || row.label
}

export function buildResourcePtyRows(args: {
  sessions: readonly PtyListedSession[]
  bindings: ResourceSessionBindingInputs
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
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
        : resolveDaemonSessionLabel(session, workspaceId, tabId, NO_RUNTIME_TITLES, bindings)
    return {
      session,
      identity: ptySessionIdentity(session),
      label,
      usesRuntimeTitle: !!tab && !tab.customTitle?.trim(),
      sortName: tab?.customTitle?.trim() || tab?.defaultTitle?.trim() || session.id,
      lastActivityAt: recentStamp(workspace ?? {}),
      workspace: workspaceName,
      workspaceId: workspace?.id ?? null,
      workspacePath: workspace?.path ?? null,
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

const NO_RUNTIME_TITLES = { runtimePaneTitlesByTabId: {} }

export const UNBOUND_RESOURCE_PTY_GROUP_KEY = 'unbound'

export function groupResourcePtyRows(rows: readonly ResourcePtyRow[]): ResourcePtyGroup[] {
  const unbound: ResourcePtyGroup = {
    key: UNBOUND_RESOURCE_PTY_GROUP_KEY,
    kind: 'unbound',
    name: null,
    rows: []
  }
  const workspaces = new Map<
    string,
    ResourcePtyGroup & { sortName: string; lastActivityAt: number; id: string }
  >()
  for (const row of rows) {
    if (row.binding === 'unbound') {
      unbound.rows.push(row)
      continue
    }
    const id = row.workspaceId ?? ''
    let workspace = workspaces.get(id)
    if (!workspace) {
      workspace = {
        key: `workspace:${id}`,
        kind: 'workspace',
        id,
        name: row.workspace,
        sortName: row.workspace?.trim().toLocaleLowerCase() ?? '\uffff',
        lastActivityAt: 0,
        rows: []
      }
      workspaces.set(id, workspace)
    }
    workspace.rows.push(row)
    workspace.lastActivityAt = Math.max(workspace.lastActivityAt, row.lastActivityAt)
  }
  const byName = (a: ResourcePtyRow, b: ResourcePtyRow): number =>
    a.sortName.localeCompare(b.sortName) || a.session.id.localeCompare(b.session.id)
  const groups: ResourcePtyGroup[] = [...workspaces.values()].sort(
    (a, b) =>
      b.lastActivityAt - a.lastActivityAt ||
      a.sortName.localeCompare(b.sortName) ||
      a.id.localeCompare(b.id)
  )
  for (const group of groups) {
    group.rows.sort(byName)
  }
  const nameCounts = new Map<string, number>()
  const projectNameCounts = new Map<string, number>()
  for (const group of groups) {
    if (group.name) {
      nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1)
      const projectName = workspaceProjectName(group)
      if (projectName) {
        projectNameCounts.set(projectName, (projectNameCounts.get(projectName) ?? 0) + 1)
      }
    }
  }
  for (const group of groups) {
    if (group.name && (nameCounts.get(group.name) ?? 0) > 1) {
      const projectName = workspaceProjectName(group)
      if (projectName && projectNameCounts.get(projectName) === 1) {
        group.name = projectName
      } else if (group.rows[0]?.workspacePath) {
        group.name = `${group.name} · ${group.rows[0].workspacePath}`
      }
    }
  }
  if (unbound.rows.length > 0) {
    unbound.rows.sort(byName)
    // Why first: PTYs no tab owns are the cleanup target, so they stay one click away.
    groups.unshift(unbound)
  }
  return groups
}

function workspaceProjectName(group: ResourcePtyGroup): string | null {
  const project = group.rows[0]?.project
  return project ? `${group.name} · ${project}` : null
}
