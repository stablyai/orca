import {
  capturedTerminalWorkspacesForPtyIds,
  capturedTerminalWorkspacesForEnvironmentIds,
  capturedPanesByTabId,
  parkedWatchersByTabId,
  retireParkedTerminalTab
} from '@/components/terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import type { AppState } from '../types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { readRecordChanges } from '@/store/keyed-record-transitions'
import { sleepingAgentRecordIndex } from './sleeping-agent-record-index'
import { getTerminalTabOwnerWorktreeId, getTerminalTabOwners } from './terminal-tab-owner-index'
import {
  invalidateTerminalParkingInputs,
  retireTerminalParkingInputs
} from '@/components/terminal-pane/parking/terminal-parking-input-events'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

const TAB_RECORDS = [
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId'
] as const
const tabIdsByPtyId = new Map<string, Set<string>>()
const ptyIdsByTabId = new Map<string, Set<string>>()
const tabIdsByEnvironmentId = new Map<string, Set<string>>()
let accepted: AppState | null = null

function sameParkingTab(previous: TerminalTab | undefined, next: TerminalTab): boolean {
  return (
    previous !== undefined &&
    previous.id === next.id &&
    previous.worktreeId === next.worktreeId &&
    previous.ptyId === next.ptyId &&
    previous.pendingActivationSpawn === next.pendingActivationSpawn &&
    previous.generation === next.generation &&
    previous.startupCwd === next.startupCwd &&
    previous.launchAgent === next.launchAgent
  )
}

function sameTitleSlots(previous: object | undefined, next: object | undefined): boolean {
  const before = Object.keys(previous ?? {})
  const after = Object.keys(next ?? {})
  return before.length === after.length && before.every((key) => key in (next ?? {}))
}

function changedKeys(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>
): Iterable<string> {
  const changes = readRecordChanges(next, previous)
  return changes?.kind === 'addressed'
    ? changes.keys
    : changes === null
      ? []
      : new Set([...Object.keys(previous), ...Object.keys(next)])
}

function replacePtyMembership(state: AppState, tabId: string): void {
  for (const ptyId of ptyIdsByTabId.get(tabId) ?? []) {
    const tabs = tabIdsByPtyId.get(ptyId)
    tabs?.delete(tabId)
    if (tabs?.size === 0) {
      tabIdsByPtyId.delete(ptyId)
    }
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
    if (environmentId) {
      const environmentTabs = tabIdsByEnvironmentId.get(environmentId)
      environmentTabs?.delete(tabId)
      if (environmentTabs?.size === 0) {
        tabIdsByEnvironmentId.delete(environmentId)
      }
    }
  }
  const worktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  const tab = worktreeId
    ? state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
    : undefined
  if (!tab) {
    ptyIdsByTabId.delete(tabId)
    return
  }
  const ptyIds = new Set([
    ...(tab.ptyId ? [tab.ptyId] : []),
    ...(state.ptyIdsByTabId[tabId] ?? []),
    ...Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}),
    ...(state.lastKnownRelayPtyIdByTabId[tabId] ? [state.lastKnownRelayPtyIdByTabId[tabId]] : [])
  ])
  ptyIdsByTabId.set(tabId, ptyIds)
  for (const ptyId of ptyIds) {
    let tabs = tabIdsByPtyId.get(ptyId)
    if (!tabs) {
      tabIdsByPtyId.set(ptyId, (tabs = new Set()))
    }
    tabs.add(tabId)
    const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
    if (environmentId) {
      let environmentTabs = tabIdsByEnvironmentId.get(environmentId)
      if (!environmentTabs) {
        tabIdsByEnvironmentId.set(environmentId, (environmentTabs = new Set()))
      }
      environmentTabs.add(tabId)
    }
  }
}

/** Accepted source ownership makes retirement synchronous without starting watchers inside a store write. */
export function acceptTerminalParkingInputs(state: AppState): ReadonlySet<string> {
  if (accepted === state) {
    return new Set()
  }
  const previous = accepted
  const dirty = new Set<string>()
  const changedTabs = new Set<string>()
  const previousOwners = previous ? getTerminalTabOwners(previous.tabsByWorktree) : null
  const oldOwners = new Map<string, string>()
  if (!previous || previous.tabsByWorktree !== state.tabsByWorktree) {
    const worktreeIds = previous
      ? changedKeys(previous.tabsByWorktree, state.tabsByWorktree)
      : Object.keys(state.tabsByWorktree)
    for (const id of worktreeIds) {
      if (previous?.tabsByWorktree[id] === state.tabsByWorktree[id]) {
        continue
      }
      const before = previous?.tabsByWorktree[id] ?? []
      const after = state.tabsByWorktree[id] ?? []
      if (
        before.length === after.length &&
        after.every((tab, index) => sameParkingTab(before[index], tab))
      ) {
        continue
      }
      dirty.add(id)
      for (const tab of previous?.tabsByWorktree[id] ?? []) {
        changedTabs.add(tab.id)
        const owner = previousOwners?.get(tab.id)
        if (owner) {
          oldOwners.set(tab.id, owner)
        }
      }
      for (const tab of state.tabsByWorktree[id] ?? []) {
        changedTabs.add(tab.id)
      }
    }
  }
  const owners = getTerminalTabOwners(state.tabsByWorktree)
  for (const field of [
    'layoutByWorktree',
    'groupsByWorktree',
    'activeGroupIdByWorktree'
  ] as const) {
    const before = previous?.[field]
    const after = state[field]
    if (before === after) {
      continue
    }
    for (const id of before ? changedKeys(before, after) : Object.keys(after)) {
      if (before?.[id] !== after[id]) {
        dirty.add(id)
      }
    }
  }
  for (const field of TAB_RECORDS) {
    const before = previous?.[field]
    const after = state[field]
    if (before === after) {
      continue
    }
    for (const tabId of before ? changedKeys(before, after) : Object.keys(after)) {
      if (
        field === 'runtimePaneTitlesByTabId' &&
        sameTitleSlots(
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
    const owner = owners.get(tabId)
    const oldOwner = oldOwners.get(tabId)
    if (owner) {
      dirty.add(owner)
    }
    if (oldOwner) {
      dirty.add(oldOwner)
    }
    replacePtyMembership(state, tabId)
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
        previous?.runtimeStatusByEnvironmentId.get(environmentId) ===
        state.runtimeStatusByEnvironmentId.get(environmentId)
      ) {
        continue
      }
      for (const id of capturedTerminalWorkspacesForEnvironmentIds([environmentId])) {
        dirty.add(id)
      }
      for (const tabId of tabIdsByEnvironmentId.get(environmentId) ?? []) {
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
    for (const worktreeId of Object.keys(state.tabsByWorktree)) {
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
    for (const worktreeId of Object.keys(accepted.tabsByWorktree)) {
      dirty.add(worktreeId)
    }
  } else {
    const changedPtyIds = [...ptyIds]
    for (const id of capturedTerminalWorkspacesForPtyIds(changedPtyIds)) {
      dirty.add(id)
    }
    for (const ptyId of changedPtyIds) {
      for (const tabId of tabIdsByPtyId.get(ptyId) ?? []) {
        const worktreeId = getTerminalTabOwnerWorktreeId(accepted.tabsByWorktree, tabId)
        if (worktreeId) {
          dirty.add(worktreeId)
        }
      }
    }
  }
  publishAcceptedTerminalParkingInputs(dirty)
}
