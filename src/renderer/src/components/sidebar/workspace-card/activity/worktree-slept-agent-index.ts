import { getTabIdToWorktreeId } from './tab-worktree-owner-index'
import { indexPaneRecordMembership } from './pane-record-membership'
import { readRecordChanges, readTabMapChanges } from '@/store/keyed-record-change-reads'
import {
  isPaneSleepRecord,
  type OwnedPaneAgentRecord
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AppState } from '@/store/types'
import { paneSleepAgentStatus } from '../../../../../../shared/agent-session/lifecycle/pane-sleep-agent-status'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { isWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { worktreeIdsEqual } from '../../../../../../shared/worktree/id'

export type SleepRowsState = Pick<AppState, 'tabsByWorktree'> &
  Partial<
    Pick<
      AppState,
      | 'sleepingAgentSessionsByPaneKey'
      | 'terminalLayoutsByTabId'
      | 'sshConnectionStates'
      | 'transientClearedAgentStatusConnectionIds'
    >
  >
const EMPTY_RECORDS: NonNullable<SleepRowsState['sleepingAgentSessionsByPaneKey']> = {}
type TabPlacement = { owner?: string; root?: TerminalPaneLayoutNode | null; leaves: Set<string> }
const records = new Map<string, OwnedPaneAgentRecord>()
const byTab = new Map<string, Set<string>>()
const byConnection = new Map<string, Set<string>>()
const placements = new Map<string, TabPlacement>()
const connections = new Map<string, boolean>()
let previous: SleepRowsState | undefined
const rowOwners = new Map<string, string>()
let byPane = new Map<string, AgentStatusEntry>()
let byWorktree = new Map<string, AgentStatusEntry[]>()

function leafSet(
  root: TerminalPaneLayoutNode | null | undefined,
  leaves = new Set<string>()
): Set<string> {
  if (root?.type === 'leaf') {
    leaves.add(root.leafId)
  } else if (root?.type === 'split') {
    leafSet(root.first, leaves)
    leafSet(root.second, leaves)
  }
  return leaves
}
function connectionVisible(state: SleepRowsState, id: string): boolean {
  return (
    state.sshConnectionStates?.get(id)?.status === 'connected' &&
    !state.transientClearedAgentStatusConnectionIds?.[id]
  )
}

function updateIndex(state: SleepRowsState, suppliedOwners?: ReadonlyMap<string, string>): void {
  const nextRecords = state.sleepingAgentSessionsByPaneKey ?? EMPTY_RECORDS
  const previousRecords = previous?.sleepingAgentSessionsByPaneKey ?? EMPTY_RECORDS
  if (
    previous &&
    nextRecords === previousRecords &&
    state.tabsByWorktree === previous.tabsByWorktree &&
    state.terminalLayoutsByTabId === previous.terminalLayoutsByTabId &&
    state.sshConnectionStates === previous.sshConnectionStates &&
    state.transientClearedAgentStatusConnectionIds ===
      previous.transientClearedAgentStatusConnectionIds
  ) {
    return
  }
  const dirty = new Set<string>()
  const checkTabs = new Set<string>()
  const checkConnections = new Set<string>()
  const track = (record: OwnedPaneAgentRecord) => {
    const pane = parsePaneKey(record.paneKey)
    if (pane) {
      checkTabs.add(pane.tabId)
    }
    if (record.connectionId) {
      checkConnections.add(record.connectionId)
    }
  }
  if (!previous || nextRecords !== previousRecords) {
    const change = previous ? readRecordChanges(nextRecords, previousRecords) : null
    const keys =
      change?.kind === 'addressed'
        ? change.keys
        : new Set([...records.keys(), ...Object.keys(nextRecords)])
    for (const key of keys) {
      const before = records.get(key)
      const candidate = nextRecords[key]
      const after = candidate && isPaneSleepRecord(candidate) ? candidate : undefined
      if (before === after) {
        continue
      }
      if (before) {
        track(before)
        indexPaneRecordMembership(byTab, byConnection, before, false)
      }
      if (after) {
        track(after)
        records.set(key, after)
        indexPaneRecordMembership(byTab, byConnection, after, true)
      } else {
        records.delete(key)
      }
      dirty.add(key)
    }
  }
  const layoutsChanged =
    !previous || state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId
  const tabsChanged = !previous || state.tabsByWorktree !== previous.tabsByWorktree
  const layoutChanges =
    layoutsChanged && previous
      ? readRecordChanges(
          state.terminalLayoutsByTabId ?? EMPTY_RECORDS,
          previous.terminalLayoutsByTabId ?? EMPTY_RECORDS
        )
      : null
  const tabChanges =
    tabsChanged && previous
      ? readTabMapChanges(state.tabsByWorktree, previous.tabsByWorktree)
      : null
  if (layoutsChanged) {
    for (const tabId of layoutChanges?.kind === 'addressed' ? layoutChanges.keys : byTab.keys()) {
      checkTabs.add(tabId)
    }
  }
  if (tabsChanged) {
    for (const tabId of tabChanges?.kind === 'addressed' ? tabChanges.tabIds : byTab.keys()) {
      checkTabs.add(tabId)
    }
  }
  for (const tabId of checkTabs) {
    const keys = byTab.get(tabId)
    if (!keys) {
      placements.delete(tabId)
      continue
    }
    const before = placements.get(tabId)
    const checkLayout =
      !before ||
      (layoutsChanged && (layoutChanges?.kind !== 'addressed' || layoutChanges.keys.has(tabId)))
    const checkOwner =
      !before || (tabsChanged && (tabChanges?.kind !== 'addressed' || tabChanges.tabIds.has(tabId)))
    const root = checkLayout ? state.terminalLayoutsByTabId?.[tabId]?.root : before?.root
    const owner = checkOwner
      ? (suppliedOwners ?? getTabIdToWorktreeId(state.tabsByWorktree)).get(tabId)
      : before?.owner
    if (!before || root !== before.root || owner !== before.owner) {
      placements.set(tabId, {
        root,
        owner,
        leaves: before && root === before.root ? before.leaves : leafSet(root)
      })
      for (const key of keys) {
        dirty.add(key)
      }
    }
  }
  const hostsChanged =
    !previous ||
    state.sshConnectionStates !== previous.sshConnectionStates ||
    state.transientClearedAgentStatusConnectionIds !==
      previous.transientClearedAgentStatusConnectionIds
  if (hostsChanged) {
    for (const id of byConnection.keys()) {
      checkConnections.add(id)
    }
  }
  if (checkConnections.size) {
    for (const id of checkConnections) {
      const keys = byConnection.get(id)
      if (!keys) {
        connections.delete(id)
        continue
      }
      const visible = connectionVisible(state, id)
      if (connections.get(id) !== visible) {
        connections.set(id, visible)
        for (const key of keys) {
          dirty.add(key)
        }
      }
    }
  }
  let nextPane = byPane
  const buckets = new Map<string, AgentStatusEntry[]>()
  const bucket = (owner: string): AgentStatusEntry[] => {
    let entries = buckets.get(owner)
    if (!entries) {
      entries = [...(byWorktree.get(owner) ?? [])]
      buckets.set(owner, entries)
    }
    return entries
  }
  for (const key of dirty) {
    const record = records.get(key)
    const pane = parsePaneKey(key)
    const placement = pane ? placements.get(pane.tabId) : undefined
    const owner = placement?.owner
    const visible =
      record &&
      pane &&
      owner &&
      (!record.tabId || record.tabId === pane.tabId) &&
      !isWebTerminalSurfaceTabId(pane.tabId) &&
      worktreeIdsEqual(owner, record.worktreeId) &&
      placement.leaves.has(pane.leafId) &&
      (!record.connectionId || connections.get(record.connectionId))
    const after = visible ? (paneSleepAgentStatus(record) ?? undefined) : undefined
    const before = byPane.get(key)
    const oldOwner = rowOwners.get(key)
    if (before === after && owner === oldOwner) {
      continue
    }
    if (nextPane === byPane) {
      nextPane = new Map(byPane)
    }
    if (before && after && owner === oldOwner && owner) {
      const entries = bucket(owner)
      entries[entries.indexOf(before)] = after
    } else {
      if (before && oldOwner) {
        const entries = bucket(oldOwner)
        entries.splice(entries.indexOf(before), 1)
      }
      if (after && owner) {
        bucket(owner).push(after)
      }
    }
    if (after && owner) {
      nextPane.set(key, after)
      rowOwners.set(key, owner)
    } else {
      nextPane.delete(key)
      rowOwners.delete(key)
    }
  }
  if (buckets.size) {
    byWorktree = new Map(byWorktree)
    for (const [owner, entries] of buckets) {
      if (entries.length) {
        byWorktree.set(owner, entries)
      } else {
        byWorktree.delete(owner)
      }
    }
  }
  byPane = nextPane
  previous = {
    tabsByWorktree: state.tabsByWorktree,
    sleepingAgentSessionsByPaneKey: nextRecords,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    sshConnectionStates: state.sshConnectionStates,
    transientClearedAgentStatusConnectionIds: state.transientClearedAgentStatusConnectionIds
  }
}

/** Disposable projections of current owned facts; unchanged owners preserve their bucket identity. */
export function sleptAgentEntriesByWorktree(
  state: SleepRowsState,
  owners?: ReadonlyMap<string, string>
): Map<string, AgentStatusEntry[]> {
  updateIndex(state, owners)
  return byWorktree
}
export function sleptAgentStatusByPaneKey(
  state: SleepRowsState
): ReadonlyMap<string, AgentStatusEntry> {
  updateIndex(state)
  return byPane
}
export function placedAgentStatusForPane(
  state: SleepRowsState & Pick<AppState, 'agentStatusByPaneKey'>,
  paneKey: string
): AgentStatusEntry | undefined {
  return state.agentStatusByPaneKey[paneKey] ?? sleptAgentStatusByPaneKey(state).get(paneKey)
}

/** The projection’s current exact placement owner; no historical row survives eviction. */
export function sleptAgentWorktreeForPane(paneKey: string): string | undefined {
  return rowOwners.get(paneKey)
}
