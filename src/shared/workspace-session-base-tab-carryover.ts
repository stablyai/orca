import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

/**
 * Base tabs kept when the host's populated row replaces the base's (#22503, #23390).
 *
 * Kept: not listed or tombstoned by the host, and either still names a PTY or was created after
 * the host's newest evidence for this workspace. Why the time bound: a tab parked on an unresolved
 * host has no PTY yet and leaves no persisted marker; legacy residue is older than the host's rows.
 */
export function baseTabsTheHostNeverListed(
  baseTabs: readonly TerminalTab[] | undefined,
  hostTabs: readonly TerminalTab[],
  base: WorkspaceSessionState,
  host: WorkspaceSessionState,
  workspaceKey: string
): TerminalTab[] {
  if (!baseTabs || baseTabs.length === 0) {
    return []
  }
  const listed = new Set(hostTabs.map((tab) => tab.id))
  const closed = (tabId: string): boolean =>
    Object.hasOwn(host.closedTerminalTabTombstonesByTabId ?? {}, tabId) ||
    Object.hasOwn(base.closedTerminalTabTombstonesByTabId ?? {}, tabId)
  const hostSeenUntil = newestHostEvidenceAt(hostTabs, host, workspaceKey)
  return baseTabs.filter(
    (tab) =>
      !listed.has(tab.id) && !closed(tab.id) && (!!tab.ptyId || tab.createdAt > hostSeenUntil)
  )
}

function newestHostEvidenceAt(
  hostTabs: readonly TerminalTab[],
  host: WorkspaceSessionState,
  workspaceKey: string
): number {
  const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(workspaceKey)
  let newest = 0
  for (const tab of hostTabs) {
    newest = Math.max(newest, tab.createdAt)
  }
  for (const tombstone of Object.values(host.closedTerminalTabTombstonesByTabId ?? {})) {
    if (normalizeWorkspaceSessionKeyToWorkspaceId(tombstone.worktreeId) === workspaceId) {
      newest = Math.max(newest, tombstone.closedAt)
    }
  }
  return newest
}

/**
 * Give each carried terminal a unified entry: a unified-format session renders only terminals listed
 * there, and a bare row hydrates with no surface and loses its PTY lease (#23390). Group repair
 * during hydration re-homes an entry whose group does not exist.
 */
export function attachCarriedTabsToUnifiedRows(
  next: WorkspaceSessionState,
  base: WorkspaceSessionState,
  host: WorkspaceSessionState,
  carriedByKey: ReadonlyMap<string, readonly TerminalTab[]>
): void {
  if (carriedByKey.size === 0 || !next.unifiedTabs) {
    return
  }
  const unifiedTabs = { ...next.unifiedTabs }
  for (const [key, carried] of carriedByKey) {
    const row = unifiedTabs[key] ?? []
    const present = new Set(row.map((tab) => tab.entityId))
    const groupId =
      host.activeGroupIdByWorktree?.[key] ?? host.tabGroups?.[key]?.[0]?.id ?? `carried:${key}`
    const additions: Tab[] = []
    for (const terminal of carried) {
      if (present.has(terminal.id)) {
        continue
      }
      const own = base.unifiedTabs?.[key]?.find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === terminal.id
      )
      additions.push(own ? { ...own, groupId } : unifiedEntryFor(terminal, key, groupId))
    }
    if (additions.length > 0) {
      unifiedTabs[key] = [...row, ...additions]
    }
  }
  next.unifiedTabs = unifiedTabs
}

function unifiedEntryFor(terminal: TerminalTab, worktreeId: string, groupId: string): Tab {
  return {
    id: terminal.id,
    entityId: terminal.id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: terminal.title,
    customLabel: terminal.customTitle,
    color: terminal.color,
    sortOrder: terminal.sortOrder,
    createdAt: terminal.createdAt
  }
}
