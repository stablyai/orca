import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  WorkspaceMultiplexerSlot,
  WorkspaceMultiplexerState
} from '../../../../shared/workspace-multiplexer-types'
import {
  findAmbiguousWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from '@/lib/unified-tab-host-ownership'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'

const NO_AMBIGUOUS_WORKTREE_IDS: ReadonlySet<string> = new Set()

export type WorkspaceMultiplexerCatalogItem = {
  identity: string
  projectIdentity: string
  worktreeId: string
  executionHostId: NonNullable<Worktree['hostId']>
  runtimeOwnerEnvironmentId?: Worktree['runtimeOwnerEnvironmentId']
  projectName: string
  projectGroupName: string | null
  projectBadgeColor: string | null
  workspaceName: string
  workspaceKind: 'worktree' | 'folder'
  branch: string | null
  isMainWorktree: boolean
  workspaceStatus: Worktree['workspaceStatus']
  path: string
  hostLabel: string | null
}

export type WorkspaceMultiplexerCatalogGroup = {
  identity: string
  projectName: string
  projectGroupName: string | null
  projectBadgeColor: string | null
  hostLabel: string | null
  items: WorkspaceMultiplexerCatalogItem[]
}

export function workspaceMultiplexerSlotIdentity(slot: WorkspaceMultiplexerSlot): string {
  return composeWorktreeHostIdentity(slot.executionHostId ?? 'local', slot.worktreeId)
}

export function findWorkspaceMultiplexerCatalogItem(
  catalog: readonly WorkspaceMultiplexerCatalogItem[],
  slot: WorkspaceMultiplexerSlot
): WorkspaceMultiplexerCatalogItem | null {
  return (
    catalog.find((item) => item.identity === workspaceMultiplexerSlotIdentity(slot)) ??
    (!slot.executionHostId
      ? (catalog.find((item) => item.worktreeId === slot.worktreeId) ?? null)
      : null)
  )
}

function findRepoForWorktree(worktree: Worktree, repos: readonly Repo[]): Repo | undefined {
  const candidates = repos.filter((repo) => repo.id === worktree.repoId)
  return (
    candidates.find((repo) => getRepoExecutionHostId(repo) === (worktree.hostId ?? 'local')) ??
    candidates[0]
  )
}

export function buildWorkspaceMultiplexerCatalog(args: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
}): WorkspaceMultiplexerCatalogItem[] {
  const projectGroupsById = new Map(args.projectGroups.map((group) => [group.id, group]))
  const rows = [
    ...args.worktrees.map((worktree) => ({ worktree, folderProject: null })),
    ...args.folderWorkspaces.map((workspace) => ({
      worktree: folderWorkspaceToWorktree(workspace),
      folderProject: projectGroupsById.get(workspace.projectGroupId) ?? null
    }))
  ].filter(({ worktree }) => !worktree.isArchived)
  const ambiguousWorkspaceIds = findAmbiguousWorktreeIds(rows.map(({ worktree }) => worktree))
  // Why: terminal/group state is still bare-id keyed, so a host collision cannot be shown safely.
  return rows
    .filter(({ worktree }) => !ambiguousWorkspaceIds.has(worktree.id))
    .map<WorkspaceMultiplexerCatalogItem>(({ worktree, folderProject }) => {
      const repo = findRepoForWorktree(worktree, args.repos)
      const executionHostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : 'local')
      const projectGroup = repo?.projectGroupId
        ? (projectGroupsById.get(repo.projectGroupId) ?? null)
        : null
      return {
        identity: composeWorktreeHostIdentity(executionHostId, worktree.id),
        projectIdentity: folderProject
          ? `folder:${folderProject.id}:${executionHostId}`
          : `repo:${repo?.id ?? worktree.repoId}:${executionHostId}`,
        worktreeId: worktree.id,
        executionHostId,
        runtimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId,
        projectName: folderProject?.name ?? repo?.displayName ?? 'Project',
        projectGroupName: folderProject ? null : (projectGroup?.name ?? null),
        projectBadgeColor: folderProject?.color ?? repo?.badgeColor ?? null,
        workspaceName: worktree.displayName || worktree.branch || worktree.path,
        workspaceKind: folderProject ? 'folder' : 'worktree',
        branch: folderProject ? null : worktree.branch,
        isMainWorktree: !folderProject && worktree.isMainWorktree,
        workspaceStatus: worktree.workspaceStatus,
        path: worktree.path,
        hostLabel: executionHostId === 'local' ? null : getExecutionHostLabel(executionHostId)
      }
    })
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName) ||
        left.workspaceName.localeCompare(right.workspaceName)
    )
}

export function workspaceMultiplexerOwnsTerminalTabs(
  workspace: WorkspaceMultiplexerCatalogItem,
  tabs: readonly Tab[],
  restoredSessionHostId?: ExecutionHostId
): boolean {
  const owner = {
    id: workspace.worktreeId,
    hostId: workspace.executionHostId,
    runtimeOwnerEnvironmentId: workspace.runtimeOwnerEnvironmentId
  }
  return tabs.every(
    (tab) =>
      tab.contentType !== 'terminal' ||
      (tab.executionHostId
        ? isUnifiedTabOwnedByWorktree(tab, owner, NO_AMBIGUOUS_WORKTREE_IDS)
        : restoredSessionHostId
          ? isExecutionHostAliasForWorktree(restoredSessionHostId, owner)
          : workspace.executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}

export function groupWorkspaceMultiplexerCatalog(
  items: readonly WorkspaceMultiplexerCatalogItem[]
): WorkspaceMultiplexerCatalogGroup[] {
  const groups = new Map<string, WorkspaceMultiplexerCatalogGroup>()
  for (const item of items) {
    const existing = groups.get(item.projectIdentity)
    if (existing) {
      existing.items.push(item)
      continue
    }
    groups.set(item.projectIdentity, {
      identity: item.projectIdentity,
      projectName: item.projectName,
      projectGroupName: item.projectGroupName,
      projectBadgeColor: item.projectBadgeColor,
      hostLabel: item.hostLabel,
      items: [item]
    })
  }
  return [...groups.values()]
}

export function countWorkspaceMultiplexerSlotsByIdentity(
  slots: readonly WorkspaceMultiplexerSlot[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const slot of slots) {
    const identity = workspaceMultiplexerSlotIdentity(slot)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}

export function countWorkspaceMultiplexerTerminalsByIdentity(
  items: readonly WorkspaceMultiplexerCatalogItem[],
  terminalTabsByWorktree: Readonly<Record<string, readonly unknown[]>>
): Map<string, number> {
  return new Map(
    items.map((item) => [item.identity, terminalTabsByWorktree[item.worktreeId]?.length ?? 0])
  )
}

export function selectWorkspaceMultiplexerGroup(args: {
  groups: readonly TabGroup[]
  tabs: readonly Tab[]
  representedGroupIds: ReadonlySet<string | null>
  activeGroupId: string | null
}): { groupId: string; activeTerminalTabId: string | null } | null {
  const groups = args.groups.filter((group) => !args.representedGroupIds.has(group.id))
  if (groups.length === 0) {
    return null
  }
  const terminalsFor = (group: TabGroup): Tab[] => terminalTabsInGroup(args.tabs, group.id)
  const groupsWithTerminals = groups.filter((group) => terminalsFor(group).length > 0)
  const group =
    groupsWithTerminals.find((candidate) => candidate.id === args.activeGroupId) ??
    groupsWithTerminals.find((candidate) =>
      terminalsFor(candidate).some((tab) => tab.id === candidate.activeTabId)
    ) ??
    groupsWithTerminals[0] ??
    groups.find((candidate) => candidate.id === args.activeGroupId) ??
    groups[0]
  const terminalTabs = terminalsFor(group)
  const terminalTab =
    terminalTabs.find((tab) => tab.id === group.activeTabId) ??
    terminalTabs.reduce<Tab | undefined>(
      (latest, tab) => ((tab.lastFocusedAt ?? 0) > (latest?.lastFocusedAt ?? 0) ? tab : latest),
      undefined
    )
  return { groupId: group.id, activeTerminalTabId: terminalTab?.entityId ?? null }
}

/** A moved terminal belongs to its new group's surface, not to the slot that last showed it. */
export function findWorkspaceMultiplexerSlotTerminalTab(
  slot: WorkspaceMultiplexerSlot,
  tabs: readonly Tab[]
): Tab | undefined {
  if (!slot.groupId || !slot.activeTerminalTabId) {
    return undefined
  }
  return tabs.find(
    (tab) =>
      tab.contentType === 'terminal' &&
      tab.groupId === slot.groupId &&
      tab.entityId === slot.activeTerminalTabId
  )
}

function terminalTabsInGroup(tabs: readonly Tab[], groupId: string): Tab[] {
  return tabs.filter((tab) => tab.groupId === groupId && tab.contentType === 'terminal')
}

export function reconcileWorkspaceMultiplexerState(
  multiplexer: WorkspaceMultiplexerState,
  groupsByWorktree: Record<string, TabGroup[]>,
  tabsByWorktree: Record<string, Tab[]>,
  catalog: readonly WorkspaceMultiplexerCatalogItem[]
): WorkspaceMultiplexerState {
  let changed = false
  const slots = multiplexer.slots.map((slot) => {
    if (!findWorkspaceMultiplexerCatalogItem(catalog, slot)) {
      return slot
    }
    const groups = groupsByWorktree[slot.worktreeId] ?? []
    if (groups.length === 0) {
      return slot
    }
    const tabs = tabsByWorktree[slot.worktreeId] ?? []
    const selectedTab = tabs.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === slot.activeTerminalTabId
    )
    const group =
      groups.find((candidate) => candidate.id === slot.groupId) ??
      (selectedTab
        ? groups.find((candidate) => candidate.id === selectedTab.groupId)
        : undefined) ??
      groups[0]
    const terminalTabs = group ? terminalTabsInGroup(tabs, group.id) : []
    const activeTab = terminalTabs.find((tab) => tab.id === group?.activeTabId)
    const activeTerminalTabId =
      terminalTabs.find((tab) => tab.entityId === slot.activeTerminalTabId)?.entityId ??
      activeTab?.entityId ??
      terminalTabs[0]?.entityId ??
      null
    const groupId = group?.id ?? null
    if (groupId === slot.groupId && activeTerminalTabId === slot.activeTerminalTabId) {
      return slot
    }
    changed = true
    return { ...slot, groupId, activeTerminalTabId }
  })
  return changed ? { ...multiplexer, slots } : multiplexer
}
