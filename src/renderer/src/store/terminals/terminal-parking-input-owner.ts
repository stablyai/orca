import {
  capturedTerminalWorkspacesForPtyIds,
  capturedTerminalWorkspacesForEnvironmentIds,
  capturedPanesByTabId,
  parkedWatchersByTabId,
  retireParkedTerminalTab
} from '@/components/terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import type { AppState } from '../types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { readTabRowChanges } from '@/store/keyed-tab-row-changes'
import {
  sameTerminalParkingTab,
  sameTerminalParkingTitleSlots,
  sameTerminalParkingAssignmentChanges
} from './terminal-parking-input-equality'
import { sleepingAgentRecordIndex } from './sleeping-agent-record-index'
import {
  getTerminalTabOwnerWorktreeIds,
  getTerminalTabOwnerWorktreeId,
  getTerminalTabOwners
} from './terminal-tab-owner-index'
import { runtimeEnvironmentSupportsTerminalParking } from '@/components/terminal-pane/parking/retention/paired-runtime-parking-capabilities'
import {
  invalidateTerminalParkingInputs,
  retireTerminalParkingInputs
} from '@/components/terminal-pane/parking/terminal-parking-input-events'
import { terminalPtyMembership } from './terminal-pty-membership'
import {
  SEAM_PARKING_TAB_FIELDS,
  SEAM_PARKING_WORKSPACE_FIELDS
} from './terminal-parking-input-fields'
let accepted: AppState | null = null

function diffUnknownParkingRecordKeys(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>
): Iterable<string> {
  const changes = readRecordChanges(next, previous)
  return changes?.kind === 'addressed'
    ? changes.keys
    : changes === null
      ? []
      : [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
          (key) =>
            previous[key] !== next[key] || Object.hasOwn(previous, key) !== Object.hasOwn(next, key)
        )
}

function resyncTerminalParkingWorkspaceIds(tabsByWorktree: AppState['tabsByWorktree']): string[] {
  return Object.keys(tabsByWorktree)
}

/** Accepted source ownership makes retirement synchronous without starting watchers inside a store write. */
export function acceptTerminalParkingInputs(state: AppState): ReadonlySet<string> {
  if (accepted === state) {
    return new Set()
  }
  const membership = terminalPtyMembership(state)
  const previous = accepted
  const dirty = new Set<string>()
  const changedTabs = new Set<string>()
  if (!previous || previous.tabsByWorktree !== state.tabsByWorktree) {
    const worktreeIds = previous
      ? diffUnknownParkingRecordKeys(previous.tabsByWorktree, state.tabsByWorktree)
      : resyncTerminalParkingWorkspaceIds(state.tabsByWorktree)
    for (const id of worktreeIds) {
      if (previous?.tabsByWorktree[id] === state.tabsByWorktree[id]) {
        continue
      }
      const before = previous?.tabsByWorktree[id] ?? []
      const after = state.tabsByWorktree[id] ?? []
      if (
        before.length === after.length &&
        after.every((tab, index) => sameTerminalParkingTab(before[index], tab))
      ) {
        continue
      }
      dirty.add(id)
      for (const tab of previous?.tabsByWorktree[id] ?? []) {
        changedTabs.add(tab.id)
      }
      for (const tab of state.tabsByWorktree[id] ?? []) {
        changedTabs.add(tab.id)
      }
    }
  }
  const owners = getTerminalTabOwners(state.tabsByWorktree)
  for (const field of SEAM_PARKING_WORKSPACE_FIELDS) {
    const before = previous?.[field]
    const after = state[field]
    if (before === after) {
      continue
    }
    for (const id of before ? diffUnknownParkingRecordKeys(before, after) : Object.keys(after)) {
      if (before?.[id] !== after[id]) {
        dirty.add(id)
      }
    }
  }
  if (previous?.unifiedTabsByWorktree !== state.unifiedTabsByWorktree) {
    const before = previous?.unifiedTabsByWorktree
    const after = state.unifiedTabsByWorktree
    const rows = before ? readTabRowChanges(after, before) : 'unknown'
    const keys = rows === 'unknown' ? undefined : rows?.keys()
    for (const id of keys ??
      (before ? diffUnknownParkingRecordKeys(before, after) : Object.keys(after))) {
      if (
        !dirty.has(id) &&
        before?.[id] !== after[id] &&
        !sameTerminalParkingAssignmentChanges(
          before?.[id] ?? [],
          after[id] ?? [],
          state.groupsByWorktree[id] ?? [],
          rows === 'unknown' ? 'unknown' : (rows?.get(id)?.values() ?? [])
        )
      ) {
        dirty.add(id)
      }
    }
  }
  for (const field of SEAM_PARKING_TAB_FIELDS) {
    const before = previous?.[field]
    const after = state[field]
    if (before === after) {
      continue
    }
    for (const tabId of before ? diffUnknownParkingRecordKeys(before, after) : Object.keys(after)) {
      if (before?.[tabId] === after[tabId]) {
        continue
      }
      if (
        field === 'runtimePaneTitlesByTabId' &&
        sameTerminalParkingTitleSlots(
          previous?.runtimePaneTitlesByTabId[tabId],
          state.runtimePaneTitlesByTabId[tabId]
        )
      ) {
        continue
      }
      if (before?.[tabId] !== after[tabId]) {
        changedTabs.add(tabId)
      }
    }
  }
  if (previous?.sleepingAgentSessionsByPaneKey !== state.sleepingAgentSessionsByPaneKey) {
    const changed = sleepingAgentRecordIndex.acceptTransition(
      previous?.sleepingAgentSessionsByPaneKey ?? null,
      state.sleepingAgentSessionsByPaneKey
    )
    for (const id of changed.worktreeIds) {
      dirty.add(id)
    }
    for (const tabId of changed.tabIds) {
      changedTabs.add(tabId)
    }
  }
  for (const tabId of changedTabs) {
    // Changed buckets cover removed owners; surviving duplicate owners may also lose authority.
    for (const id of getTerminalTabOwnerWorktreeIds(state.tabsByWorktree, tabId)) {
      dirty.add(id)
    }
  }
  if (previous?.runtimeStatusByEnvironmentId !== state.runtimeStatusByEnvironmentId) {
    const changes = previous
      ? readRecordChanges(state.runtimeStatusByEnvironmentId, previous.runtimeStatusByEnvironmentId)
      : null
    const environmentIds =
      changes?.kind === 'addressed'
        ? changes.keys
        : new Set([
            ...(previous?.runtimeStatusByEnvironmentId.keys() ?? []),
            ...state.runtimeStatusByEnvironmentId.keys()
          ])
    for (const environmentId of environmentIds) {
      if (
        runtimeEnvironmentSupportsTerminalParking(
          previous?.runtimeStatusByEnvironmentId.get(environmentId)
        ) ===
        runtimeEnvironmentSupportsTerminalParking(
          state.runtimeStatusByEnvironmentId.get(environmentId)
        )
      ) {
        continue
      }
      for (const id of capturedTerminalWorkspacesForEnvironmentIds([environmentId])) {
        dirty.add(id)
      }
      for (const tabId of membership.parkingTabsForEnvironment(environmentId)) {
        const owner = owners.get(tabId)
        if (owner) {
          dirty.add(owner)
        }
      }
    }
  }
  if (
    previous &&
    previous.settings?.terminalSshViewParking !== state.settings?.terminalSshViewParking
  ) {
    for (const worktreeId of resyncTerminalParkingWorkspaceIds(state.tabsByWorktree)) {
      dirty.add(worktreeId)
    }
  }
  accepted = state
  return dirty
}

export function publishAcceptedTerminalParkingInputs(worktreeIds: ReadonlySet<string>): void {
  for (const worktreeId of worktreeIds) {
    for (const tabId of new Set([
      ...capturedPanesByTabId.workspaceTabIds(worktreeId),
      ...parkedWatchersByTabId.workspaceTabIds(worktreeId)
    ])) {
      if (
        accepted &&
        getTerminalTabOwnerWorktreeId(accepted.tabsByWorktree, tabId) !== worktreeId
      ) {
        retireParkedTerminalTab(tabId)
      }
    }
    if (accepted && !(worktreeId in accepted.tabsByWorktree)) {
      retireTerminalParkingInputs(worktreeId)
    } else {
      invalidateTerminalParkingInputs(worktreeId)
    }
  }
}

export function invalidateTerminalParkingPtyInputs(ptyIds?: Iterable<string>): void {
  if (!accepted) {
    return
  }
  const dirty = new Set<string>()
  if (ptyIds === undefined) {
    for (const worktreeId of resyncTerminalParkingWorkspaceIds(accepted.tabsByWorktree)) {
      dirty.add(worktreeId)
    }
  } else {
    const changedPtyIds = [...ptyIds]
    for (const id of capturedTerminalWorkspacesForPtyIds(changedPtyIds)) {
      dirty.add(id)
    }
    for (const ptyId of changedPtyIds) {
      for (const tabId of terminalPtyMembership(accepted).parkingTabsForPty(ptyId)) {
        const worktreeId = getTerminalTabOwnerWorktreeId(accepted.tabsByWorktree, tabId)
        if (worktreeId) {
          dirty.add(worktreeId)
        }
      }
    }
  }
  publishAcceptedTerminalParkingInputs(dirty)
}
