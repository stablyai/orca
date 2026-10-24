import { useAppStore, type AppState } from '@/store'
import * as workspace from '@/store/workspace-record-selectors'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey,
  parseLegacyNumericPaneKey
} from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'
import {
  resolveFocusedTabAgent,
  resolveSiblingTabAgent,
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent
} from './tab-agent'
import { resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'

type Observation = { generation: string; observed: boolean }
const observations = new Map<string, Observation>()
const listeners = new Map<string, Set<() => void>>()
export function subscribeTabAgentObservation(tabId: string, listener: () => void): () => void {
  let bucket = listeners.get(tabId)
  if (!bucket) {
    listeners.set(tabId, (bucket = new Set()))
  }
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) {
      listeners.delete(tabId)
    }
  }
}
export function getTabAgentObservation(tabId: string): boolean {
  return observations.get(tabId)?.observed ?? false
}
function notify(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) {
    listener()
  }
}
function observe(tab: TerminalTab, state: AppState): void {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const activeLeafId = layout?.activeLeafId
  const ptyIds = state.ptyIdsByTabId[tab.id] ?? []
  const ptyId =
    (activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : null) ||
    (ptyIds.length === 1 ? ptyIds[0] : null)
  const paneKey =
    activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tab.id, activeLeafId) : null
  const process = paneKey ? state.paneForegroundAgentByPaneKey[paneKey] : undefined
  const focusedHookAgent = resolveFocusedTabAgent(state.agentStatusByPaneKey, layout, tab.id)
  const siblingHookAgent = resolveSiblingTabAgent(state.agentStatusByPaneKey, layout, tab.id)
  const completed =
    resolveFocusedCompletedTabAgent(state.agentStatusByPaneKey, layout, tab.id) ??
    resolveFocusedRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tab.id)
  const completedHookEvidence =
    completed !== null &&
    (Boolean(activeLeafId && isTerminalLeafId(activeLeafId)) || ptyIds.length <= 1)
  const isRemote =
    worktreeUsesRemoteConnection(state, tab.worktreeId) ||
    hasRemoteRuntimePtyForTab(ptyIds, layout?.ptyIdsByLeafId)
  const generation = `${ptyId ?? ''}|${String(isRemote)}`
  const previous = observations.get(tab.id)
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(tab.title)
  const fallbackSignal = tab.launchAgent
    ? explicitTitleAgent === tab.launchAgent
    : Boolean(explicitTitleAgent || siblingHookAgent)
  const observed = Boolean(
    (previous?.generation === generation && previous.observed) ||
    focusedHookAgent ||
    completedHookEvidence ||
    process?.agent ||
    fallbackSignal
  )
  // Publish the generation before clearing: the action synchronously re-enters this subscriber.
  observations.set(tab.id, { generation, observed })
  if (previous?.observed !== observed) {
    notify(tab.id)
  }
  if (
    !tab.launchAgent ||
    !resolveLaunchedAgentExitEvidence({
      title: tab.title,
      defaultTitle: tab.defaultTitle,
      isRemote,
      hasObservedAgentSignal: observed,
      hookAgent: focusedHookAgent,
      siblingHookAgent,
      hasCompletedHook: completedHookEvidence,
      processAgent: process?.agent,
      processShellForeground: process?.shellForeground
    })
  ) {
    return
  }
  const current = useAppStore.getState()
  const currentTab = current.tabsByWorktree[tab.worktreeId]?.find(
    (candidate) => candidate.id === tab.id
  )
  if (currentTab === tab) {
    current.clearTabLaunchAgent(tab.id)
  }
}
export function startTabAgentExitOwner(): () => void {
  const tabs = new Map<string, TerminalTab>()
  const index = (state: AppState): void => {
    tabs.clear()
    for (const bucket of Object.values(state.tabsByWorktree)) {
      for (const tab of bucket) {
        tabs.set(tab.id, tab)
      }
    }
    for (const id of observations.keys()) {
      if (!tabs.has(id)) {
        observations.delete(id)
        notify(id)
      }
    }
  }
  index(useAppStore.getState())
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const affected = new Set<string>()
    if (state.tabsByWorktree !== previous.tabsByWorktree) {
      for (const id of new Set([
        ...Object.keys(state.tabsByWorktree),
        ...Object.keys(previous.tabsByWorktree)
      ])) {
        if (state.tabsByWorktree[id] === previous.tabsByWorktree[id]) {
          continue
        }
        for (const tab of previous.tabsByWorktree[id] ?? []) {
          tabs.delete(tab.id)
          affected.add(tab.id)
        }
        for (const tab of state.tabsByWorktree[id] ?? []) {
          tabs.set(tab.id, tab)
          affected.add(tab.id)
        }
      }
    }
    for (const [values, before, paneKeys] of [
      [state.terminalLayoutsByTabId, previous.terminalLayoutsByTabId, false],
      [state.ptyIdsByTabId, previous.ptyIdsByTabId, false],
      [state.agentStatusByPaneKey, previous.agentStatusByPaneKey, true],
      [state.retainedAgentsByPaneKey, previous.retainedAgentsByPaneKey, true],
      [state.paneForegroundAgentByPaneKey, previous.paneForegroundAgentByPaneKey, true]
    ] as const) {
      if (values === before) {
        continue
      }
      for (const key of new Set([...Object.keys(values), ...Object.keys(before)])) {
        if (values[key] === before[key]) {
          continue
        }
        const tabId = paneKeys
          ? (parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId)
          : key
        if (tabId) {
          affected.add(tabId)
        }
      }
    }
    if (
      workspace.selectFolderWorkspaces(state) !== workspace.selectFolderWorkspaces(previous) ||
      state.projectGroups !== previous.projectGroups ||
      state.repos !== previous.repos ||
      workspace.selectWorktreesByRepo(state) !== workspace.selectWorktreesByRepo(previous)
    ) {
      for (const id of tabs.keys()) {
        affected.add(id)
      }
    }
    for (const id of affected) {
      // Re-read after every action: a nested clear may replace the bucket being processed.
      const indexed = tabs.get(id)
      const current = useAppStore.getState()
      const tab =
        indexed &&
        current.tabsByWorktree[indexed.worktreeId]?.find((candidate) => candidate.id === id)
      if (tab) {
        observe(tab, current)
      } else {
        observations.delete(id)
        notify(id)
      }
    }
  })
  for (const tab of tabs.values()) {
    const current = useAppStore.getState()
    const live = current.tabsByWorktree[tab.worktreeId]?.find(
      (candidate) => candidate.id === tab.id
    )
    if (live) {
      observe(live, current)
    }
  }
  return () => {
    unsubscribe()
    observations.clear()
    for (const id of listeners.keys()) {
      notify(id)
    }
  }
}
