import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { isSyntheticAgentPermissionTitle } from '../../../../shared/synthetic-agent-title'
import { resolveRuntimePaneTitleLeafId } from '@/lib/runtime-pane-title-leaf-id'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { PaneInput } from './smart-attention'

export type TabPaneInputSources = {
  entriesByTabId: ReadonlyMap<string, AgentStatusEntry[]>
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
}

export function collectTabPaneInputs(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  worktreeLastActivityAt: number,
  sources: TabPaneInputSources,
  now: number
): PaneInput[] {
  const panes: PaneInput[] = []
  const hasLivePty = tabHasLivePty(sources.ptyIdsByTabId, tab.id)
  const hookLeafIds = new Set<string>()
  const permissionHookLeafIds = new Set<string>()
  for (const entry of sources.entriesByTabId.get(tab.id) ?? []) {
    panes.push({ kind: 'hook', entry, hasLivePty })
    const leafId = leafIdFromPaneKey(entry.paneKey)
    if (leafId !== null) {
      permissionHookLeafIds.add(leafId)
    }
    if (entry.executionObservation && leafId !== null) {
      hookLeafIds.add(leafId)
      continue
    }
    if (
      !entry.restoredUnconfirmed &&
      !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ) {
      continue
    }
    if (leafId !== null) {
      hookLeafIds.add(leafId)
    }
  }
  if (!hasLivePty) {
    return panes
  }
  const paneTitles = sources.runtimePaneTitlesByTabId[tab.id]
  if (!paneTitles || Object.keys(paneTitles).length === 0) {
    const coveredLeafIds = isSyntheticAgentPermissionTitle(tab.title)
      ? permissionHookLeafIds
      : hookLeafIds
    if (coveredLeafIds.size === 0) {
      panes.push({
        kind: 'title',
        status: classifyTitleActivity(tab.title),
        worktreeLastActivityAt
      })
    }
    return panes
  }
  const tabLayout = sources.terminalLayoutsByTabId?.[tab.id]
  const paneTitleEntries = Object.entries(paneTitles)
  for (const [runtimePaneId, title] of paneTitleEntries) {
    const coveredLeafIds = isSyntheticAgentPermissionTitle(title)
      ? permissionHookLeafIds
      : hookLeafIds
    const leafId = resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId)
    const hasSingleUnmappedHook =
      leafId === null && coveredLeafIds.size === 1 && paneTitleEntries.length === 1
    if ((leafId !== null && coveredLeafIds.has(leafId)) || hasSingleUnmappedHook) {
      continue
    }
    panes.push({ kind: 'title', status: classifyTitleActivity(title), worktreeLastActivityAt })
  }
  return panes
}

function leafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.lastIndexOf(':')
  return separator === -1 ? null : paneKey.slice(separator + 1) || null
}

export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
): Map<string, AgentStatusEntry[]> {
  const byTab = new Map<string, AgentStatusEntry[]>()
  const pushEntry = (entry: AgentStatusEntry): void => {
    const parsed = parsePaneKey(entry.paneKey)
    if (!parsed) {
      return
    }
    const bucket = byTab.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTab.set(parsed.tabId, [entry])
    }
  }
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    pushEntry(entry)
  }
  for (const entry of Object.values(migrationUnsupportedByPtyId ?? {})) {
    const agentEntry = migrationUnsupportedToAgentStatusEntry(entry)
    if (agentEntry) {
      pushEntry(agentEntry)
    }
  }
  return byTab
}

export function buildExplicitEntriesByWorktreeId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, AgentStatusEntry[]> {
  const byWorktree = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    if (!entry.worktreeId || !parsePaneKey(entry.paneKey)) {
      continue
    }
    const bucket = byWorktree.get(entry.worktreeId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byWorktree.set(entry.worktreeId, [entry])
    }
  }
  return byWorktree
}
