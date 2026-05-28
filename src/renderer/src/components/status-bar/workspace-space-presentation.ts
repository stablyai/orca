import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'

export type WorkspaceSpaceSortKey = 'size' | 'name' | 'repo' | 'activity'
export type WorkspaceSpaceSortDirection = 'asc' | 'desc'

export type WorkspaceSpaceDeleteReadiness = {
  isActive: boolean
  changedFileCount: number | null
  dirtyEditorBufferCount: number
  activeAgentCount: number
  liveTerminalCount: number
  browserTabCount: number
  reviewLabel: string | null
  issueLabel: string | null
  linearIssueLabel: string | null
}

export type WorkspaceSpaceAgentActivityInputs = {
  worktreeId: string
  tabs: readonly Pick<TerminalTab, 'id' | 'title'>[]
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  now: number
}

function getPaneKeyTabId(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId
  }

  // Why: older hydrated snapshots can still carry `tabId:numericPaneId`.
  // Delete readiness only needs tab ownership, so preserve the conservative
  // "workspace is in use" signal instead of treating the row as deletable.
  const separatorIndex = paneKey.indexOf(':')
  if (
    separatorIndex <= 0 ||
    separatorIndex !== paneKey.lastIndexOf(':') ||
    separatorIndex === paneKey.length - 1
  ) {
    return null
  }
  return paneKey.slice(0, separatorIndex)
}

function isActiveAgentState(entry: Pick<AgentStatusEntry, 'state'>): boolean {
  return entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting'
}

function countTitleActiveAgentsForTab(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>
): number {
  if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
    return 0
  }

  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    return Object.values(paneTitles).filter((title) => {
      const status = detectAgentStatusFromTitle(title)
      return status === 'working' || status === 'permission'
    }).length
  }

  const status = detectAgentStatusFromTitle(tab.title)
  return status === 'working' || status === 'permission' ? 1 : 0
}

export function countWorkspaceSpaceActiveAgents({
  worktreeId,
  tabs,
  agentStatusByPaneKey,
  migrationUnsupportedByPtyId,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  now
}: WorkspaceSpaceAgentActivityInputs): number {
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const tabsWithActiveHook = new Set<string>()
  let count = 0

  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (!isActiveAgentState(entry)) {
      continue
    }
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const tabId = getPaneKeyTabId(entry.paneKey || paneKey)
    if (!tabId || !tabIds.has(tabId)) {
      continue
    }
    tabsWithActiveHook.add(tabId)
    count += 1
  }

  for (const entry of Object.values(migrationUnsupportedByPtyId)) {
    const tabId = entry.tabId ?? (entry.paneKey ? getPaneKeyTabId(entry.paneKey) : null)
    if (entry.worktreeId !== worktreeId && (!tabId || !tabIds.has(tabId))) {
      continue
    }
    if (tabId) {
      tabsWithActiveHook.add(tabId)
    }
    count += 1
  }

  for (const tab of tabs) {
    if (tabsWithActiveHook.has(tab.id)) {
      continue
    }
    count += countTitleActiveAgentsForTab(tab, runtimePaneTitlesByTabId, ptyIdsByTabId)
  }

  return count
}

export function getWorkspaceSpaceSearchText(worktree: WorkspaceSpaceWorktree): string {
  return [
    worktree.displayName,
    worktree.repoDisplayName,
    worktree.path,
    worktree.branch,
    worktree.status
  ]
    .join(' ')
    .toLowerCase()
}

function compareRows(
  left: WorkspaceSpaceWorktree,
  right: WorkspaceSpaceWorktree,
  sortKey: WorkspaceSpaceSortKey
): number {
  switch (sortKey) {
    case 'size':
      return left.sizeBytes - right.sizeBytes
    case 'name':
      return left.displayName.localeCompare(right.displayName)
    case 'repo':
      return (
        left.repoDisplayName.localeCompare(right.repoDisplayName) ||
        left.displayName.localeCompare(right.displayName)
      )
    case 'activity':
      return left.lastActivityAt - right.lastActivityAt
  }
}

export function sortWorkspaceSpaceRows(
  rows: readonly WorkspaceSpaceWorktree[],
  sortKey: WorkspaceSpaceSortKey,
  direction: WorkspaceSpaceSortDirection
): WorkspaceSpaceWorktree[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const primary = compareRows(left, right, sortKey) * multiplier
    return (
      primary ||
      right.sizeBytes - left.sizeBytes ||
      left.displayName.localeCompare(right.displayName)
    )
  })
}

export function filterWorkspaceSpaceRows(
  rows: readonly WorkspaceSpaceWorktree[],
  query: string,
  onlyDeletable: boolean
): WorkspaceSpaceWorktree[] {
  const normalizedQuery = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (onlyDeletable && !row.canDelete) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return getWorkspaceSpaceSearchText(row).includes(normalizedQuery)
  })
}

export function isWorkspaceSpaceRowReadyToDelete(
  worktree: WorkspaceSpaceWorktree,
  readiness: WorkspaceSpaceDeleteReadiness | undefined
): boolean {
  return (
    worktree.canDelete &&
    worktree.status === 'ok' &&
    !worktree.isMainWorktree &&
    readiness !== undefined &&
    !readiness.isActive &&
    readiness.changedFileCount === 0 &&
    readiness.dirtyEditorBufferCount === 0 &&
    readiness.activeAgentCount === 0 &&
    readiness.liveTerminalCount === 0 &&
    readiness.browserTabCount === 0 &&
    !readiness.reviewLabel &&
    !readiness.issueLabel &&
    !readiness.linearIssueLabel
  )
}

export function getWorkspaceSpaceGitStatusRefreshCandidates(
  rows: readonly WorkspaceSpaceWorktree[]
): WorkspaceSpaceWorktree[] {
  return rows.filter(
    (worktree) => worktree.canDelete && worktree.status === 'ok' && !worktree.isMainWorktree
  )
}

export function getSelectedDeletableWorkspaceIds(
  rows: readonly WorkspaceSpaceWorktree[],
  selectedIds: ReadonlySet<string>,
  isWorktreeDeleting: (worktreeId: string) => boolean = () => false
): string[] {
  return rows
    .filter(
      (row) =>
        row.canDelete &&
        row.status === 'ok' &&
        selectedIds.has(row.worktreeId) &&
        !isWorktreeDeleting(row.worktreeId)
    )
    .map((row) => row.worktreeId)
}

export function getVisibleDeletableWorkspaceIds(
  rows: readonly WorkspaceSpaceWorktree[],
  isWorktreeDeleting: (worktreeId: string) => boolean = () => false
): string[] {
  return rows
    .filter((row) => row.canDelete && row.status === 'ok' && !isWorktreeDeleting(row.worktreeId))
    .map((row) => row.worktreeId)
}
