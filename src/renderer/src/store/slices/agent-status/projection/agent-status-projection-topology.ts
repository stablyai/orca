import type { AppState } from '../../../types'
import { structuredTabsShowingConversation } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import {
  orchestrationForStatusRows,
  remoteRowContextsFor
} from '@/runtime/agent-orchestration/remote-row-orchestration'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusChange } from '../contracts/agent-status-contract'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { parseAgentStatusPaneIdentity } from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { buildTitleDerivedAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-title-derived-agent-rows'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import { AgentStatusStoreDraftTable } from '../../../../../../shared/agent-status/store/agent-status-store-table'
import {
  readRecordChanges,
  readTabMapChanges
} from '../../../record-transitions/keyed-record-change-reads'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../../shared/agent-status/presentation/migration-unsupported-agent-entry'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  EMPTY_STRING_SET,
  changedRemoteRowKeys,
  collectOwnKeys
} from './agent-status-projection-key-diff'

const SEAM_AGENT_PRESENTATION_FIELDS = [
  'runtimePaneTitlesByTabId',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId'
] as const

export function stageProjectionTopology(
  data: AgentStatusProjectionState,
  state: AppState,
  changes: readonly AgentStatusChange[],
  refreshKeys: readonly string[]
) {
  const previous = data.inputs
  let movedSet: Set<string> | undefined
  if (state.agentStatusByPaneKey.replacementCount > 0) {
    for (const key of state.agentStatusByPaneKey.stagedKeys()) {
      if (state.agentStatusByPaneKey.wasMoved(key)) {
        ;(movedSet ??= new Set()).add(key)
      }
    }
  }
  const moved: ReadonlySet<string> = movedSet ?? EMPTY_STRING_SET
  const changedTabs = new Set<string>()
  const bindingTabs = new Set<string>()
  const acceptedKeys = new Set<string>()
  const changedKeys = new Set<string>()
  for (let i = 0; i < changes.length; i += 1) {
    const paneKey = changes[i].paneKey
    acceptedKeys.add(paneKey)
    changedKeys.add(paneKey)
  }
  for (let i = 0; i < refreshKeys.length; i += 1) {
    changedKeys.add(refreshKeys[i])
  }
  const nextTabs = new Map<string, TerminalTab | null>()
  const nextTabOwners = new Map<string, string | null>()
  if (state.tabsByWorktree !== previous?.tabsByWorktree) {
    const diff = previous ? readTabMapChanges(state.tabsByWorktree, previous.tabsByWorktree) : null
    const owners =
      diff?.kind === 'addressed'
        ? diff.workspaceIds
        : collectOwnKeys(previous?.tabsByWorktree, state.tabsByWorktree)
    for (const owner of owners) {
      const prevOwnerTabs = previous?.tabsByWorktree[owner]
      if (prevOwnerTabs) {
        for (const tab of prevOwnerTabs) {
          if (diff?.kind === 'addressed' && !diff.tabIds.has(tab.id)) {
            continue
          }
          nextTabs.set(tab.id, null)
          nextTabOwners.set(tab.id, null)
          changedTabs.add(tab.id)
          bindingTabs.add(tab.id)
        }
      }
      const nextOwnerTabs = state.tabsByWorktree[owner]
      if (nextOwnerTabs) {
        for (const tab of nextOwnerTabs) {
          if (diff?.kind === 'addressed' && !diff.tabIds.has(tab.id)) {
            continue
          }
          nextTabs.set(tab.id, tab)
          nextTabOwners.set(tab.id, owner)
          changedTabs.add(tab.id)
          bindingTabs.add(tab.id)
        }
      }
    }
  }
  const represented = new AgentStatusStoreDraftTable(data.represented)
  if (state.unifiedTabsByWorktree !== previous?.unifiedTabsByWorktree) {
    const diff = previous
      ? readTabMapChanges(state.unifiedTabsByWorktree, previous.unifiedTabsByWorktree)
      : null
    const owners =
      diff?.kind === 'addressed'
        ? diff.workspaceIds
        : collectOwnKeys(previous?.unifiedTabsByWorktree, state.unifiedTabsByWorktree)
    const removedKeys = new Set<string>()
    // The first tab listed for a conversation represents it, as the status bridge's member does.
    const insertedKeys = new Set<string>()
    for (const owner of owners) {
      const prevUnified = previous?.unifiedTabsByWorktree[owner]
      if (prevUnified) {
        for (const tab of prevUnified) {
          if (
            tab.contentType === 'agent-session' &&
            (diff?.kind !== 'addressed' || diff.tabIds.has(tab.id))
          ) {
            changedTabs.add(tab.id)
            const key = chatPaneKey(tab.entityId)
            changedKeys.add(key)
            represented.delete(key)
            removedKeys.add(key)
            nextTabOwners.set(tab.id, null)
          }
        }
      }
    }
    // Insert after every removal: a chat moved between workspaces keeps its one conversation key.
    for (const owner of owners) {
      const nextUnified = state.unifiedTabsByWorktree[owner]
      if (nextUnified) {
        for (const tab of nextUnified) {
          if (
            tab.contentType === 'agent-session' &&
            (diff?.kind !== 'addressed' || diff.tabIds.has(tab.id))
          ) {
            changedTabs.add(tab.id)
            const key = chatPaneKey(tab.entityId)
            changedKeys.add(key)
            removedKeys.delete(key)
            if (isStructuredTab(tab) && !insertedKeys.has(key)) {
              insertedKeys.add(key)
              represented.set(key, tab)
            }
            nextTabOwners.set(tab.id, owner)
          }
        }
      }
    }
    // A closed tab's conversation that another open tab, in any workspace, still shows stays represented.
    for (const key of removedKeys) {
      const [survivor] = structuredTabsShowingConversation(state.unifiedTabsByWorktree, key)
      if (survivor) {
        represented.set(key, survivor)
      }
    }
  }
  for (const field of SEAM_AGENT_PRESENTATION_FIELDS) {
    if (state[field] === previous?.[field]) {
      continue
    }
    const diff = previous ? readRecordChanges(state[field], previous[field]) : null
    for (const tab of diff?.kind === 'addressed'
      ? diff.keys
      : collectOwnKeys(previous?.[field], state[field])) {
      changedTabs.add(tab)
      if (field !== 'runtimePaneTitlesByTabId' && state[field][tab] !== previous?.[field][tab]) {
        bindingTabs.add(tab)
      }
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
  // Rows whose remote context changed re-place, as the local map's keys do.
  const remoteRows = remoteRowContextsFor(state)
  for (const key of changedRemoteRowKeys(data.remoteRows, remoteRows)) {
    changedKeys.add(key)
    const identity = parseAgentStatusPaneIdentity(key, represented.get(key))
    if (identity) {
      changedTabs.add(identity.tabId)
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
      runtimeAgentOrchestrationByPaneKey: orchestrationForStatusRows(state),
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
    remoteRows,
    moved,
    changedTabs,
    bindingTabs,
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
