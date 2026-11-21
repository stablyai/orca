import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { AppState } from '../../../types'
import {
  movedAgentSenderChannels,
  samePublishingHosts
} from '@/runtime/native-chat/agent-senders/agent-sender-index'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  readTerminalLeafAgentTypes,
  stageTerminalLeafAgentTypes
} from './agent-status-projection-terminal-types'
import { stageAcceptedAgentTransitions } from './agent-status-projection-transitions'
import type {
  AgentStatusChange,
  AgentStatusChangeListener
} from '../contracts/agent-status-contract'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import type { WorktreeAgentActivitySummary } from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
import type { WorktreeAttention } from '../../../../../../shared/sidebar-list/sorting/smart-attention'
import type { TabAgentPane } from '@/lib/agent-session/tab-identity/tab-agent-status-index'
import {
  EMPTY_KEYS,
  EMPTY_ICONS,
  EMPTY_SUMMARY,
  type DashboardCounts
} from './agent-status-projection-types'
import { AgentStatusProjectionState } from './agent-status-projection-state'
import {
  readProjectionAttention,
  readProjectionMobileSnapshots
} from './agent-status-projection-reads'
import { projectionEvictionKeys } from './agent-status-projection-capacity'
import { captureProjectionState } from './agent-status-projection-capture'
import { stageProjectionTopology } from './agent-status-projection-topology'
import { stageProjectionRows } from './agent-status-projection-rows'
import { stageProjectionCounts } from './agent-status-projection-counts'
import { publishProjectionTopology } from './agent-status-projection-publish-topology'
import { publishProjectionRows } from './agent-status-projection-publish-rows'
import { publishProjectionArrangement } from './agent-status-projection-publish-arrangement'

import { KeyedChangeJournal } from '../../../../../../shared/collections/keyed-change-journal'

/** Live keyed derivatives; historical views capture explicitly. */
export class AgentStatusProjection {
  private data = new AgentStatusProjectionState()
  private changes = new KeyedChangeJournal()
  changeCursor(): number {
    return this.changes.cursor()
  }
  changesSince(cursor: number): ReadonlySet<string> | null {
    return this.changes.since(cursor)
  }
  get display() {
    return this.data.display
  }
  dashboardCounts(): DashboardCounts {
    return this.data.dashboardTotals
  }
  terminalLeafAgentTypes(tabId: string) {
    return readTerminalLeafAgentTypes(this.data, tabId)
  }
  hasActiveAgents(): boolean {
    return this.data.activeAgentCount > 0
  }
  subscribeTransitions(listener: AgentStatusChangeListener): () => void {
    this.data.transitionListeners.add(listener)
    return () => this.data.transitionListeners.delete(listener)
  }
  subscribeChanges(listener: (keys: ReadonlySet<string> | null) => void): () => void {
    this.data.changeListeners.add(listener)
    return () => this.data.changeListeners.delete(listener)
  }
  /** Accepted keys published but not yet delivered to change listeners; null while unknown. */
  pendingChangedKeys(): ReadonlySet<string> | null {
    return this.data.fullResync || this.data.notifying ? null : this.data.changedKeys
  }
  subscribe(channel: string, listener: () => void): () => void {
    const listeners = this.data.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.data.listeners.set(channel, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        this.data.listeners.delete(channel)
      }
    }
  }
  notify(): void {
    if (this.data.notifying) {
      return
    }
    this.data.notifying = true
    try {
      while (
        this.data.notices.size ||
        this.data.changedKeys.size ||
        this.data.fullResync ||
        this.data.transitionBatches.length
      ) {
        const transitions = this.data.transitionBatches.splice(0)
        for (const batch of transitions) {
          for (const listener of Array.from(this.data.transitionListeners)) {
            if (this.data.transitionListeners.has(listener)) {
              try {
                listener(batch)
              } catch (error) {
                console.error('Agent transition observer failed', error)
              }
            }
          }
        }
        const keys = this.data.fullResync ? null : new Set(this.data.changedKeys)
        this.data.fullResync = false
        this.data.changedKeys.clear()
        for (const listener of Array.from(this.data.changeListeners)) {
          if (this.data.changeListeners.has(listener) && (keys === null || keys.size)) {
            try {
              listener(keys)
            } catch (error) {
              console.error('Agent status observer failed', error)
            }
          }
        }
        const channels = [...this.data.notices]
        this.data.notices.clear()
        const listeners = new Set(
          channels.flatMap((channel) => Array.from(this.data.listeners.get(channel) ?? []))
        )
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.error('Agent presentation observer failed', error)
          }
        }
      }
    } finally {
      this.data.notifying = false
    }
  }
  mobileSource(key: string, tabId: string) {
    const worktreeId = this.data.mobileOwners.get(key)
    const tab = this.data.tabs.get(tabId)
    return worktreeId && tab ? { worktreeId, tab } : undefined
  }
  tabKeys(tabId: string): Iterable<string> {
    return this.data.acceptedByTab.get(tabId) ?? []
  }
  orphanKeys(owner: string): Iterable<string> {
    return this.data.orphansByOwner.get(owner) ?? []
  }
  handleKeys(handle: string): Iterable<string> {
    return this.data.keysByHandle.get(handle) ?? EMPTY_KEYS
  }
  tabBar(): typeof this.data.tabProjection {
    return this.data.tabProjection
  }
  hasFreshEvidence(): boolean {
    return this.data.freshEvidence > 0
  }
  row(key: string): DashboardAgentRow | undefined {
    return this.data.rows.get(key)
  }
  rowOwnersRevision(): number {
    return this.data.rowOwnersRevision
  }
  rowWorktree(key: string): string | undefined {
    return this.data.ownerForSource.get(key) ?? this.data.rows.get(key)?.tab.worktreeId
  }
  keys(worktreeId: string): readonly string[] {
    return this.data.worktrees.get(worktreeId)?.arrangement ?? EMPTY_KEYS
  }
  revision(worktreeId: string): number {
    return this.data.worktrees.get(worktreeId)?.revision ?? 0
  }
  summary(worktreeId: string): WorktreeAgentActivitySummary {
    return this.data.worktrees.get(worktreeId)?.summary ?? EMPTY_SUMMARY
  }
  tabPanes(tabId: string, done: boolean): readonly TabAgentPane[] {
    const icons = this.data.iconsByTab.get(tabId)
    if (!icons) {
      return EMPTY_ICONS
    }
    const field = done ? 'doneOutput' : 'liveOutput'
    return (icons[field] ??= [...icons[done ? 'done' : 'live']]
      .sort((a, b) => this.data.ranks.get(a)! - this.data.ranks.get(b)!)
      .map((key) => this.data.icons.get(key)!.pane))
  }
  list(worktreeId: string): DashboardAgentRow[] {
    const revision = this.revision(worktreeId),
      cached = this.data.fullRows.get(worktreeId)
    if (cached?.revision === revision) {
      return cached.rows
    }
    const rows = this.keys(worktreeId).map((key) => this.data.rows.get(key)!)
    this.data.fullRows.set(worktreeId, { revision, rows })
    return rows
  }
  entries(worktreeId: string, statuses: ReadonlyMap<string, AgentStatusEntry>): AgentStatusEntry[] {
    return this.keys(worktreeId).flatMap((key) => {
      const row = statuses.get(key)
      return row ? [row] : []
    })
  }
  attention(worktreeId: string, lastActivityAt = 0, now = Date.now()): WorktreeAttention {
    return readProjectionAttention(this.data, worktreeId, lastActivityAt, now)
  }
  mobileSnapshots(
    statuses: AppState['agentStatusByPaneKey']
  ): ReadonlyMap<string, ReadonlyMap<string, AgentStatusEntry>> {
    return readProjectionMobileSnapshots(this.data, statuses)
  }
  evictionKeys(
    statuses: AppState['agentStatusByPaneKey'],
    layouts: AppState['terminalLayoutsByTabId'],
    protectedKey: string,
    now: number,
    max: number
  ): string[] {
    return projectionEvictionKeys(this.data, statuses, layouts, protectedKey, now, max)
  }
  capture(): AgentStatusProjection {
    const captured = new AgentStatusProjection()
    captured.data = captureProjectionState(this.data)
    return captured
  }
  prepare(
    state: AppState,
    changes: readonly AgentStatusChange[],
    refreshKeys: readonly string[] = [],
    fullResync = false
  ): () => void {
    const data = this.data
    const topology = stageProjectionTopology(data, state, changes, refreshKeys)
    const publishTerminalTypes = stageTerminalLeafAgentTypes(data, state, topology.changedKeys)
    const publishTransitions = stageAcceptedAgentTransitions(data, state, changes)
    const rows = stageProjectionRows(data, state, topology)
    const { previous } = topology
    const ownerInputs = structuredAgentSessionOwnerInputs(state)
    const oldOwnerInputs = previous ? structuredAgentSessionOwnerInputs(previous) : []
    const sendersChanged =
      previous?.agentSenderPublicationsByHost !== state.agentSenderPublicationsByHost
    const senderLocationsChanged =
      !previous ||
      (sendersChanged && !samePublishingHosts(previous, state)) ||
      previous.tabsByWorktree !== state.tabsByWorktree ||
      previous.unifiedTabsByWorktree !== state.unifiedTabsByWorktree ||
      ownerInputs.some((value, index) => value !== oldOwnerInputs[index]) ||
      changes.some(
        (change) =>
          change.previous?.terminalHandle !== change.current?.terminalHandle ||
          (Boolean(change.previous?.terminalHandle || change.current?.terminalHandle) &&
            change.previous?.worktreeId !== change.current?.worktreeId)
      )
    // Only a publication moved: notify the senders whose answer it moved, not every card.
    const movedSenders =
      previous && sendersChanged && !senderLocationsChanged
        ? movedAgentSenderChannels(previous, state, data.listeners.keys())
        : []
    const publishCounts = stageProjectionCounts(data, state, rows.prepared)
    return () => {
      const changed = new Set(topology.changedKeys)
      for (const [key, next] of rows.prepared) {
        changed.add(key)
        for (const rowKey of data.rowsForSource.get(key) ?? []) {
          changed.add(rowKey)
        }
        for (const row of next.rows) {
          changed.add(row.paneKey)
        }
      }
      data.fullResync ||= fullResync
      for (const key of refreshKeys) {
        data.notices.add(`status\0${key}`)
      }
      if (senderLocationsChanged) {
        data.notices.add('sender-locations')
      }
      for (const channel of movedSenders) {
        data.notices.add(channel)
      }
      publishCounts()
      publishTerminalTypes()
      publishTransitions()
      publishProjectionTopology(data, state, changes, topology, rows)
      const rowUpdates = publishProjectionRows(data, state, topology, rows)
      publishProjectionArrangement(data, state, topology, rows, rowUpdates)
      // Membership changes can move a key across commits a reader skipped.
      this.changes.publish(
        fullResync ||
          topology.moved.size > 0 ||
          changes.some(({ previous, current }) => !previous || !current)
          ? null
          : changed
      )
    }
  }
}
