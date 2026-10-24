import { useAppStore } from '../../store'
import { clearTerminalTabColdParkRecheckTimers } from './terminal-cold-park-recheck-timers'
import { selectPairedRuntimeParkingEnvironmentIdsFromState } from './terminal-hidden-view-parking'
import {
  haveSameTerminalTabIds,
  getTerminalParkingInputsKey
} from './terminal-parking-reconciliation-key'
import {
  canWatcherCoverParkedTerminalTab,
  pruneParkedTerminalWatchers,
  terminalWatcherLiveWorkspaceIds,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-parked-tab-watchers'
import { subscribeTerminalPaneSplitMountLeases } from './terminal-pane-split-request-routing'
import type { WorkspacePolicy, TerminalOverlayTabAssignment } from './terminal-tab-parking-policy'
const EMPTY: ReadonlySet<string> = new Set()
type TerminalParkingInputOwner = {
  policies: Map<string, WorkspacePolicy>
  pending: Map<string, ParkedTerminalTabWatcherSyncEntry>
  fallback: Map<string, ParkedTerminalTabWatcherSyncEntry>
  evaluate: (policy: WorkspacePolicy) => void
  queuePolicy: (policy: WorkspacePolicy) => void
  notify: (id: string) => void
  requestFlush: () => void
}
export function subscribeTerminalParkingInputs(runtime: TerminalParkingInputOwner): () => void {
  const { policies, pending, fallback, evaluate, queuePolicy, notify, requestFlush } = runtime
  const tabWorkspaces = new Map<string, string>()
  function retireMissingPolicies(): void {
    const state = useAppStore.getState()
    for (const [id, policy] of policies) {
      if (state.tabsByWorktree[id]?.length) {
        continue
      }
      clearTerminalTabColdParkRecheckTimers(policy.timers)
      policies.delete(id)
      pending.set(id, { tabs: [], parkedTabIds: EMPTY })
      notify(id)
    }
    tabWorkspaces.clear()
    for (const [id, tabs] of Object.entries(state.tabsByWorktree)) {
      for (const tab of tabs) {
        tabWorkspaces.set(tab.id, id)
      }
    }
    pruneParkedTerminalWatchers(terminalWatcherLiveWorkspaceIds(Object.keys(state.tabsByWorktree)))
  }
  function queueUnvisited(): void {
    for (const [id, tabs] of Object.entries(useAppStore.getState().tabsByWorktree)) {
      if (policies.has(id) || fallback.has(id)) {
        continue
      }
      const parked = new Set(
        tabs.filter((tab) => canWatcherCoverParkedTerminalTab(id, tab)).map((tab) => tab.id)
      )
      pending.set(id, { tabs, parkedTabIds: parked, restoreTitleOnStartTabIds: parked })
    }
  }
  retireMissingPolicies()
  queueUnvisited()
  requestFlush()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const topologyChanged = state.tabsByWorktree !== previous.tabsByWorktree
    const sharedChanged =
      state.settings?.terminalHiddenViewParking !== previous.settings?.terminalHiddenViewParking ||
      state.settings?.terminalSshViewParking !== previous.settings?.terminalSshViewParking ||
      !haveSameTerminalTabIds(
        selectPairedRuntimeParkingEnvironmentIdsFromState(previous),
        selectPairedRuntimeParkingEnvironmentIdsFromState(state)
      )
    const affected = new Set<string>()
    if (sharedChanged) {
      for (const id of policies.keys()) {
        affected.add(id)
      }
    }
    if (state.sleepingAgentSessionsByPaneKey !== previous.sleepingAgentSessionsByPaneKey) {
      for (const key of new Set([
        ...Object.keys(state.sleepingAgentSessionsByPaneKey),
        ...Object.keys(previous.sleepingAgentSessionsByPaneKey)
      ])) {
        const next = state.sleepingAgentSessionsByPaneKey[key]
        const old = previous.sleepingAgentSessionsByPaneKey[key]
        if (next === old) {
          continue
        }
        if (next) {
          affected.add(next.worktreeId)
        }
        if (old) {
          affected.add(old.worktreeId)
        }
      }
    }
    if (topologyChanged) {
      for (const id of new Set([
        ...Object.keys(state.tabsByWorktree),
        ...Object.keys(previous.tabsByWorktree)
      ])) {
        if (state.tabsByWorktree[id] === previous.tabsByWorktree[id]) {
          continue
        }
        const policy = policies.get(id)
        const tabs = state.tabsByWorktree[id] ?? []
        for (const tab of previous.tabsByWorktree[id] ?? []) {
          tabWorkspaces.delete(tab.id)
        }
        for (const tab of tabs) {
          tabWorkspaces.set(tab.id, id)
        }
        if (!tabs.length) {
          if (policy) {
            clearTerminalTabColdParkRecheckTimers(policy.timers)
          }
          policies.delete(id)
          pending.set(id, { tabs: [], parkedTabIds: EMPTY })
          fallback.delete(id)
          notify(id)
          continue
        }
        if (!policy && !fallback.has(id)) {
          const parked = new Set(
            tabs.filter((tab) => canWatcherCoverParkedTerminalTab(id, tab)).map((tab) => tab.id)
          )
          pending.set(id, { tabs, parkedTabIds: parked, restoreTitleOnStartTabIds: parked })
        }
        if (policy) {
          policy.input = { ...policy.input, terminalTabs: tabs }
          if (
            getTerminalParkingInputsKey(tabs) !==
            getTerminalParkingInputsKey(previous.tabsByWorktree[id] ?? [])
          ) {
            affected.add(id)
          }
        }
      }
    }
    if (
      state.groupsByWorktree !== previous.groupsByWorktree ||
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      state.activeGroupIdByWorktree !== previous.activeGroupIdByWorktree
    ) {
      for (const [id, policy] of policies) {
        if (
          state.groupsByWorktree[id] === previous.groupsByWorktree[id] &&
          state.unifiedTabsByWorktree[id] === previous.unifiedTabsByWorktree[id] &&
          state.activeGroupIdByWorktree[id] === previous.activeGroupIdByWorktree[id]
        ) {
          continue
        }
        const groups = state.groupsByWorktree[id] ?? []
        const assignments = new Map<string, TerminalOverlayTabAssignment>()
        let activeTerminalTabId: string | null = null
        for (const tab of state.unifiedTabsByWorktree[id] ?? []) {
          if (tab.contentType !== 'terminal') {
            continue
          }
          const isActiveInGroup = groups.some(
            (group) => group.id === tab.groupId && group.activeTabId === tab.id
          )
          assignments.set(tab.entityId, { groupId: tab.groupId, isActiveInGroup })
          if (isActiveInGroup && tab.groupId === state.activeGroupIdByWorktree[id]) {
            activeTerminalTabId = tab.entityId
          }
        }
        policy.input = { ...policy.input, assignments, activeTerminalTabId }
        affected.add(id)
      }
    }
    for (const [values, before, titleOnly] of [
      [state.ptyIdsByTabId, previous.ptyIdsByTabId, false],
      [state.terminalLayoutsByTabId, previous.terminalLayoutsByTabId, false],
      [state.pendingStartupByTabId, previous.pendingStartupByTabId, false],
      [state.runtimePaneTitlesByTabId, previous.runtimePaneTitlesByTabId, true]
    ] as const) {
      if (values === before) {
        continue
      }
      for (const tabId of new Set([...Object.keys(values), ...Object.keys(before)])) {
        if (values[tabId] === before[tabId]) {
          continue
        }
        const id = tabWorkspaces.get(tabId)
        const policy = id ? policies.get(id) : undefined
        if (!policy) {
          const entry = id ? fallback.get(id) : undefined
          if (id && entry) {
            pending.set(id, { ...entry, tabs: state.tabsByWorktree[id] ?? [] })
          }
          continue
        }
        if (titleOnly) {
          queuePolicy(policy)
        } else {
          affected.add(policy.input.worktreeId)
        }
      }
    }
    for (const id of affected) {
      const policy = policies.get(id)
      if (!policy) {
        continue
      }
      evaluate(policy)
      queuePolicy(policy)
      notify(id)
    }
    if (sharedChanged) {
      queueUnvisited()
    }
    if (pending.size) {
      requestFlush()
    }
  })
  const split = subscribeTerminalPaneSplitMountLeases(() => {
    for (const [id, policy] of policies) {
      evaluate(policy)
      notify(id)
      queuePolicy(policy)
    }
  })
  return () => {
    unsubscribe()
    split()
  }
}
