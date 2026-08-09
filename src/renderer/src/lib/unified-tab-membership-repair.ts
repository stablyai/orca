import type { Tab, TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../shared/execution-host'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import { createBrowserUuid } from './browser-uuid'

type RepairOptions = {
  worktreeIds: ReadonlySet<string>
}

function hasPtyEvidence(session: WorkspaceSessionState, tab: TerminalTab): boolean {
  if (tab.ptyId) {
    return true
  }
  const bindings = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId
  if (bindings && Object.keys(bindings).length > 0) {
    return true
  }
  return Boolean(session.remoteSessionIdsByTabId?.[tab.id])
}

function toUnifiedTab(tab: TerminalTab, groupId: string, worktreeId: string): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: tab.title,
    ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
    ...(tab.quickCommandLabel?.trim() ? { quickCommandLabel: tab.quickCommandLabel.trim() } : {}),
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: tab.isPinned ?? false,
    ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
  }
}

/** Re-materialize terminal tabs that exist only in the legacy `tabsByWorktree`
 *  map into the unified tab model.
 *
 *  Why: direct-SSH host partitions and remote workspace snapshots persist
 *  terminal membership in legacy format only, while hydration renders tabs from
 *  `unifiedTabs`/`tabGroups` whenever those maps exist. Without this repair a
 *  durable terminal restored through a legacy-only source reattaches its PTY
 *  but never gets a visible tab, and the next session write persists the loss. */
export function repairUnifiedTabMembershipFromLegacyTabs(
  session: WorkspaceSessionState,
  options: RepairOptions
): WorkspaceSessionState {
  if (!session.unifiedTabs || !session.tabGroups) {
    // Legacy-only blobs hydrate through the legacy path, which reads tabsByWorktree directly.
    return session
  }
  let unifiedTabs = session.unifiedTabs
  let tabGroups = session.tabGroups
  let activeGroupIdByWorktree = session.activeGroupIdByWorktree
  let changed = false
  // Why: dedup must span every worktree and content type — a tab id surviving
  // under another key (or as editor content) must not be minted a second time.
  const knownUnifiedIds = new Set(
    Object.values(unifiedTabs)
      .flat()
      .flatMap((tab) => [tab.id, tab.entityId])
  )
  for (const worktreeId of options.worktreeIds) {
    const legacyTabs = session.tabsByWorktree?.[worktreeId] ?? []
    if (legacyTabs.length === 0) {
      continue
    }
    const existing = unifiedTabs[worktreeId] ?? []
    // Why: PTY evidence is required — materializing unbound stale tabs spawns
    // fresh shells and can trigger sleeping-agent resume in discarded panes.
    // Web-mirror surfaces never mount a local pane, so they are never repaired.
    const missing = legacyTabs
      .filter((tab) => isValidHostTerminalTabId(tab.id) && !knownUnifiedIds.has(tab.id))
      .filter((tab) => hasPtyEvidence(session, tab))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    if (missing.length === 0) {
      continue
    }
    const groups = tabGroups[worktreeId] ?? []
    const activeGroupId = activeGroupIdByWorktree?.[worktreeId]
    const targetGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0]
    const groupId = targetGroup?.id ?? createBrowserUuid()
    const synthesized = missing.map((tab) => toUnifiedTab(tab, groupId, worktreeId))
    const appendedIds = synthesized.map((tab) => tab.id)
    for (const appendedId of appendedIds) {
      knownUnifiedIds.add(appendedId)
    }
    const rememberedActiveTabId = session.activeTabIdByWorktree?.[worktreeId]
    const fallbackActiveTabId =
      rememberedActiveTabId && appendedIds.includes(rememberedActiveTabId)
        ? rememberedActiveTabId
        : appendedIds[0]
    if (!changed) {
      unifiedTabs = { ...unifiedTabs }
      tabGroups = { ...tabGroups }
      changed = true
    }
    unifiedTabs[worktreeId] = [...existing, ...synthesized]
    if (targetGroup) {
      tabGroups[worktreeId] = groups.map((group) =>
        group === targetGroup
          ? {
              ...group,
              tabOrder: [
                ...group.tabOrder,
                ...appendedIds.filter((id) => !group.tabOrder.includes(id))
              ],
              activeTabId: group.activeTabId ?? fallbackActiveTabId
            }
          : group
      )
    } else {
      tabGroups[worktreeId] = [
        {
          id: groupId,
          worktreeId,
          activeTabId: fallbackActiveTabId,
          tabOrder: appendedIds,
          recentTabIds: []
        }
      ]
      activeGroupIdByWorktree = { ...activeGroupIdByWorktree, [worktreeId]: groupId }
    }
  }
  if (!changed) {
    return session
  }
  return { ...session, unifiedTabs, tabGroups, activeGroupIdByWorktree }
}

/** Prefer the local partition's richer tab records for ids a direct-SSH
 *  partition also tracks.
 *
 *  Why: the partition's spawn-raced records are minimal (generic title, fresh
 *  timestamps) and would otherwise whole-key shadow the local partition's
 *  titles, colors and ordering; only the PTY binding is authoritative there. */
export function enrichDirectSshLegacyTabRecords(
  slices: Partial<Record<string, WorkspaceSessionState | undefined>>
): void {
  const local = slices[LOCAL_EXECUTION_HOST_ID]
  if (!local?.tabsByWorktree) {
    return
  }
  const localById = new Map(
    Object.values(local.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab])
  )
  for (const [hostId, slice] of Object.entries(slices)) {
    if (!slice?.tabsByWorktree || parseExecutionHostId(hostId)?.kind !== 'ssh') {
      continue
    }
    for (const [worktreeId, tabs] of Object.entries(slice.tabsByWorktree)) {
      slice.tabsByWorktree[worktreeId] = tabs.map((tab) => {
        const localTab = localById.get(tab.id)
        return localTab
          ? {
              ...localTab,
              ptyId: tab.ptyId ?? localTab.ptyId,
              ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {})
            }
          : tab
      })
    }
  }
}

/** Worktrees whose legacy terminal membership came from a direct-SSH host
 *  partition — the only startup source that persists tabs in legacy format. */
export function collectDirectSshLegacyTabWorktreeIds(
  slices: Partial<Record<string, Pick<WorkspaceSessionState, 'tabsByWorktree'> | undefined>>
): Set<string> {
  const worktreeIds = new Set<string>()
  for (const [hostId, slice] of Object.entries(slices)) {
    if (!slice || parseExecutionHostId(hostId)?.kind !== 'ssh') {
      continue
    }
    for (const worktreeId of Object.keys(slice.tabsByWorktree ?? {})) {
      worktreeIds.add(worktreeId)
    }
  }
  return worktreeIds
}
