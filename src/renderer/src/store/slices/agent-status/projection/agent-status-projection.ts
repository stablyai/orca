import type { AppState } from '../../../types'
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
import {
  detectProjectionSenderChanges,
  isAgentStatusProjectionNoop
} from './agent-status-projection-noop'
import { publishProjectionTopology } from './agent-status-projection-publish-topology'
import { publishProjectionRows } from './agent-status-projection-publish-rows'
import { publishProjectionArrangement } from './agent-status-projection-publish-arrangement'
import { notifyProjectionListeners } from './agent-status-projection-notify'

import { KeyedChangeJournal } from '../../../../../../shared/collections/keyed-change-journal'

const EMPTY_DASHBOARD_ROWS: DashboardAgentRow[] = []

/** Live keyed derivatives; historical views capture explicitly. */
export class AgentStatusProjection {
  private data = new AgentStatusProjectionState()
  private changes = new KeyedChangeJournal()
  private worktreeJournal = new KeyedChangeJournal()
  private pendingNoopInputs: AppState | null = null
  private readonly commitNoop = (): void => {
    if (this.pendingNoopInputs !== null) {
      this.data.inputs = this.pendingNoopInputs
      this.pendingNoopInputs = null
    }
  }
  /** Workspaces whose rows, arrangement or summary moved, by commit; null when any may have. */
  readonly worktreeChanges: Pick<KeyedChangeJournal, 'cursor' | 'since'> = this.worktreeJournal
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
    notifyProjectionListeners(this.data)
  }
  mobileSource(key: string, tabId: string) {
    const worktreeId = this.data.mobileOwners.get(key)
    const tab = this.data.tabs.get(tabId)
    return worktreeId && tab ? { worktreeId, tab } : undefined
  }
  tabKeys(tabId: string): Iterable<string> {
    return this.data.acceptedByTab.get(tabId) ?? EMPTY_KEYS
  }
  orphanKeys(owner: string): Iterable<string> {
    return this.data.orphansByOwner.get(owner) ?? EMPTY_KEYS
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
    const keys = this.keys(worktreeId)
    if (keys.length === 0) {
      return EMPTY_DASHBOARD_ROWS
    }
    const revision = this.revision(worktreeId),
      cached = this.data.fullRows.get(worktreeId)
    if (cached?.revision === revision) {
      return cached.rows
    }
    const rows: DashboardAgentRow[] = []
    for (let i = 0; i < keys.length; i += 1) {
      rows.push(this.data.rows.get(keys[i])!)
    }
    this.data.fullRows.set(worktreeId, { revision, rows })
    return rows
  }
  entries(worktreeId: string, statuses: ReadonlyMap<string, AgentStatusEntry>): AgentStatusEntry[] {
    const keys = this.keys(worktreeId)
    const result: AgentStatusEntry[] = []
    for (let i = 0; i < keys.length; i += 1) {
      const row = statuses.get(keys[i])
      if (row) {
        result.push(row)
      }
    }
    return result
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
    if (isAgentStatusProjectionNoop(data, state, changes, refreshKeys, fullResync)) {
      this.pendingNoopInputs = state
      return this.commitNoop
    }
    const topology = stageProjectionTopology(data, state, changes, refreshKeys)
    const publishTerminalTypes = stageTerminalLeafAgentTypes(data, state, topology.changedKeys)
    const publishTransitions = stageAcceptedAgentTransitions(data, state, changes)
    const rows = stageProjectionRows(data, state, topology)
    const { senderLocationsChanged, movedSenders } = detectProjectionSenderChanges(
      data,
      topology.previous,
      state,
      changes
    )
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
      // Cleared only once published, so a commit that threw part-way hands its workspaces to the next.
      if (fullResync || data.touchedWorktrees.size) {
        this.worktreeJournal.publish(fullResync ? null : new Set(data.touchedWorktrees))
        data.touchedWorktrees.clear()
      }
    }
  }
}
