import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { isValidTerminalTabId } from '../../../../../shared/workspace-layout/terminal-surfaces/terminal-tab-id'
import {
  readCanonicalPtyOwners,
  resolveCanonicalPtyClaim
} from '../../../../../shared/workspace-layout/terminal-topology/legacy-terminal-row-claims'
import { workspaceRootGroupId } from '../../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'

export function terminalRowTabEntry(row: TerminalTab, worktreeId: string, groupId: string): Tab {
  return {
    id: row.id,
    entityId: row.id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: row.title,
    ...(row.quickCommandLabel?.trim() ? { quickCommandLabel: row.quickCommandLabel.trim() } : {}),
    ...(row.generatedTitle?.trim() ? { generatedLabel: row.generatedTitle.trim() } : {}),
    ...(row.aiVaultTitle ? { aiVaultTitle: row.aiVaultTitle } : {}),
    customLabel: row.customTitle,
    color: row.color,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt
  }
}

/** Saved terminals the tab bar never listed restore as tabs, as main's layout load reads them;
 *  a row whose every terminal another tab already holds is a stale copy and stays out. */
export function withSavedTerminalRowEntries(
  session: WorkspaceSessionState,
  worktreeId: string,
  entries: readonly Tab[]
): readonly Tab[] {
  const rows = session.tabsByWorktree[worktreeId] ?? []
  const listed = new Set(
    entries.flatMap((entry) => (entry.contentType === 'terminal' ? [entry.entityId] : []))
  )
  const unlisted = rows.filter((row) => {
    if (listed.has(row.id) || !isValidTerminalTabId(row.id)) {
      return false
    }
    listed.add(row.id)
    return true
  })
  if (unlisted.length === 0) {
    return entries
  }
  const canonical = readCanonicalPtyOwners(session, worktreeId, rows)
  const groups = session.tabGroups?.[worktreeId] ?? []
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  // Like reconnect adoption: the active group, so reattach cannot spawn a duplicate.
  const groupId =
    groups.find((group) => group.id === activeGroupId)?.id ??
    groups[0]?.id ??
    workspaceRootGroupId(worktreeId)
  const added = unlisted
    .filter((row) => resolveCanonicalPtyClaim(session, row, canonical).kind === 'retained')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map((row) => terminalRowTabEntry(row, worktreeId, groupId))
  return added.length > 0 ? [...entries, ...added] : entries
}
