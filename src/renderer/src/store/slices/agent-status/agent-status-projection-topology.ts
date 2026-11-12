import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusChange } from './agent-status-contract'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { parseAgentStatusPaneIdentity } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { buildTitleDerivedAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-title-derived-agent-rows'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { readRecordChanges, readTabMapChanges } from '../../keyed-record-change-reads'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../shared/migration-unsupported-agent-entry'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

export function stageProjectionTopology(
  data: AgentStatusProjectionState,
  state: AppState,
  changes: readonly AgentStatusChange[],
  refreshKeys: readonly string[]
) {
  const previous = data.inputs
  const moved = new Set(
    [...state.agentStatusByPaneKey.stagedKeys()].filter((key) =>
      state.agentStatusByPaneKey.wasMoved(key)
    )
  )
  const changedTabs = new Set<string>()
  const acceptedKeys = new Set(changes.map((change) => change.paneKey))
  const changedKeys = new Set([...acceptedKeys, ...refreshKeys])
  const nextTabs = new Map<string, TerminalTab | null>()
  const nextTabOwners = new Map<string, string | null>()
  if (state.tabsByWorktree !== previous?.tabsByWorktree) {
    const diff = previous ? readTabMapChanges(state.tabsByWorktree, previous.tabsByWorktree) : null
    const owners =
      diff?.kind === 'addressed'
        ? diff.workspaceIds
        : new Set([
            ...Object.keys(previous?.tabsByWorktree ?? {}),
            ...Object.keys(state.tabsByWorktree ?? {})
          ])
    for (const owner of owners) {
      for (const tab of previous?.tabsByWorktree[owner] ?? []) {
        if (diff?.kind === 'addressed' && !diff.tabIds.has(tab.id)) {
          continue
        }
        nextTabs.set(tab.id, null)
        nextTabOwners.set(tab.id, null)
        changedTabs.add(tab.id)
      }
      for (const tab of state.tabsByWorktree[owner] ?? []) {
        if (diff?.kind === 'addressed' && !diff.tabIds.has(tab.id)) {
          continue
        }
        nextTabs.set(tab.id, tab)
        nextTabOwners.set(tab.id, owner)
        changedTabs.add(tab.id)
      }
    }
  }
  const represented =
    state.unifiedTabsByWorktree !== previous?.unifiedTabsByWorktree
      ? getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree ?? {})
      : data.represented
  if (represented !== data.represented) {
    const diff = previous
      ? readTabMapChanges(state.unifiedTabsByWorktree, previous.unifiedTabsByWorktree)
      : null
    const owners =
      diff?.kind === 'addressed'
        ? diff.workspaceIds
        : new Set([
            ...Object.keys(previous?.unifiedTabsByWorktree ?? {}),
            ...Object.keys(state.unifiedTabsByWorktree ?? {})
          ])
    for (const owner of owners) {
      for (const tab of previous?.unifiedTabsByWorktree[owner] ?? []) {
        if (
          tab.contentType === 'agent-session' &&
          (diff?.kind !== 'addressed' || diff.tabIds.has(tab.id))
        ) {
          changedTabs.add(tab.id)
          nextTabOwners.set(tab.id, null)
        }
      }
      for (const tab of state.unifiedTabsByWorktree[owner] ?? []) {
        if (
          tab.contentType === 'agent-session' &&
          (diff?.kind !== 'addressed' || diff.tabIds.has(tab.id))
        ) {
          changedTabs.add(tab.id)
          nextTabOwners.set(tab.id, owner)
        }
      }
    }
    for (const [key, tab] of data.represented) {
      if (changedTabs.has(tab.id)) {
        changedKeys.add(key)
      }
    }
    for (const [key, tab] of represented) {
      if (changedTabs.has(tab.id)) {
        changedKeys.add(key)
      }
    }
  }
  const presentationFields = [
    'runtimePaneTitlesByTabId',
    'ptyIdsByTabId',
    'terminalLayoutsByTabId'
  ] as const
  for (const field of presentationFields) {
    if (state[field] === previous?.[field]) {
      continue
    }
    const diff = previous ? readRecordChanges(state[field], previous[field]) : null
    for (const tab of diff?.kind === 'addressed'
      ? diff.keys
      : new Set([...Object.keys(previous?.[field] ?? {}), ...Object.keys(state[field] ?? {})])) {
      changedTabs.add(tab)
    }
  }
  for (const field of [
    'paneForegroundAgentByPaneKey',
    'runtimeAgentOrchestrationByPaneKey'
  ] as const) {
    if (state[field] === previous?.[field]) {
      continue
    }
    const diff = previous ? readRecordChanges(state[field], previous[field]) : null
    for (const key of diff?.kind === 'addressed'
      ? diff.keys
      : new Set([...Object.keys(previous?.[field] ?? {}), ...Object.keys(state[field] ?? {})])) {
      changedKeys.add(key)
      const identity = parseAgentStatusPaneIdentity(key, represented.get(key))
      if (identity) {
        changedTabs.add(identity.tabId)
      }
    }
  }
  const nextUnsupported = new Map<string, AgentStatusEntry | null>()
  if (state.migrationUnsupportedByPtyId !== previous?.migrationUnsupportedByPtyId) {
    const diff = previous
      ? readRecordChanges(state.migrationUnsupportedByPtyId, previous.migrationUnsupportedByPtyId)
      : null
    for (const pty of diff?.kind === 'addressed'
      ? diff.keys
      : new Set([
          ...Object.keys(previous?.migrationUnsupportedByPtyId ?? {}),
          ...Object.keys(state.migrationUnsupportedByPtyId ?? {})
        ])) {
      const old = previous?.migrationUnsupportedByPtyId[pty],
        current = state.migrationUnsupportedByPtyId[pty]
      if (old?.paneKey) {
        nextUnsupported.set(old.paneKey, null)
        changedKeys.add(old.paneKey)
      }
      const row = current ? migrationUnsupportedToAgentStatusEntry(current) : null
      if (row) {
        nextUnsupported.set(row.paneKey, row)
        changedKeys.add(row.paneKey)
      }
    }
  }
  const now = Date.now(),
    nextFallback = new Map<string, DashboardAgentRow | null>(),
    nextFallbackTabs = new Map<string, Set<string>>()
  for (const tabId of changedTabs) {
    for (const key of data.acceptedByTab.get(tabId) ?? []) {
      changedKeys.add(key)
    }
    for (const key of data.fallbackByTab.get(tabId) ?? []) {
      nextFallback.set(key, null)
      changedKeys.add(key)
    }
    const tab = nextTabs.has(tabId) ? nextTabs.get(tabId) : data.tabs.get(tabId)
    const keys = new Set<string>()
    nextFallbackTabs.set(tabId, keys)
    if (!tab) {
      continue
    }
    for (const row of buildTitleDerivedAgentRows({
      tabs: [tab],
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
      now,
      seenPaneKeys: new Set()
    })) {
      nextFallback.set(row.paneKey, row)
      keys.add(row.paneKey)
      changedKeys.add(row.paneKey)
    }
  }
  if (!previous) {
    for (const key of state.agentStatusByPaneKey.keys()) {
      changedKeys.add(key)
    }
  }
  const ownerOf = (tabId: string): string | undefined =>
    nextTabOwners.has(tabId)
      ? (nextTabOwners.get(tabId) ?? undefined)
      : data.tabWorktrees.get(tabId)
  const sourceEntry = (key: string) =>
    state.agentStatusByPaneKey.get(key) ??
    (nextUnsupported.has(key) ? nextUnsupported.get(key) : data.unsupportedRows.get(key))
  return {
    previous,
    moved,
    changedTabs,
    acceptedKeys,
    changedKeys,
    nextTabs,
    nextTabOwners,
    represented,
    nextUnsupported,
    now,
    nextFallback,
    nextFallbackTabs,
    ownerOf,
    sourceEntry
  }
}
export type ProjectionTopology = ReturnType<typeof stageProjectionTopology>
