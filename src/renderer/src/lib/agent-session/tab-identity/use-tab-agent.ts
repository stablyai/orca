import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { worktreeUsesRemoteConnection } from '@/store/terminals/tabs/creation/terminal-workspace-routing'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import {
  hasObservedTabAgentSignal,
  resolveLaunchedAgentExitEvidence,
  resolveTabAgentFromSignals
} from '../../../../../shared/tab-agent-from-signals'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

type TabHookAgents = {
  focused: TerminalAgent | null
  sibling: TerminalAgent | null
  focusedCompleted: TerminalAgent | null
  siblingCompleted: TerminalAgent | null
}

/** Every mounted tab re-runs these on each store write; recompute only when this tab's hook inputs change. */
function createTabHookAgentResolver(): (
  s: Pick<AppState, 'agentStatusByPaneKey' | 'terminalLayoutsByTabId'>,
  tabId: string
) => TabHookAgents {
  let last: {
    tabId: string
    statuses: AppState['agentStatusByPaneKey']
    layout: AppState['terminalLayoutsByTabId'][string] | undefined
    agents: TabHookAgents
  } | null = null
  return (s, tabId) => {
    const statuses = s.agentStatusByPaneKey
    const layout = s.terminalLayoutsByTabId[tabId]
    if (last && last.tabId === tabId && last.statuses === statuses && last.layout === layout) {
      return last.agents
    }
    const agents: TabHookAgents = {
      focused: resolveFocusedTabAgent(statuses, layout, tabId),
      sibling: resolveSiblingTabAgent(statuses, layout, tabId),
      focusedCompleted: resolveFocusedCompletedTabAgent(statuses, layout, tabId),
      siblingCompleted: resolveSiblingCompletedTabAgent(statuses, layout, tabId)
    }
    last = { tabId, statuses, layout, agents }
    return agents
  }
}

/** Resolve pane identity, separate from activity, without foreground probes: live focused hook → process (normalized to owner group) → reuse/hookless title → completed focused identity → sleeping session → launch → sibling fallback. Native OpenCode titles cannot displace durable ownership; local OSC 133;D suppresses exited idle identity. */
export function useTabAgent(tab: TerminalTab): TerminalAgent | null {
  const [resolveHookAgents] = useState(createTabHookAgentResolver)
  const focusedHookAgent = useAppStore((s) => resolveHookAgents(s, tab.id).focused)
  const siblingHookAgent = useAppStore((s) => resolveHookAgents(s, tab.id).sibling)
  const focusedCompletedHookAgent = useAppStore(
    (s) => resolveHookAgents(s, tab.id).focusedCompleted
  )
  const siblingCompletedHookAgent = useAppStore(
    (s) => resolveHookAgents(s, tab.id).siblingCompleted
  )
  const hasCompletedHook = focusedCompletedHookAgent !== null
  const clearTabLaunchAgent = useAppStore((s) => s.clearTabLaunchAgent)
  const focusedPaneKey = useAppStore((s) => {
    const activeLeafId = s.terminalLayoutsByTabId[tab.id]?.activeLeafId
    return activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tab.id, activeLeafId) : null
  })
  const processAgent = useAppStore((s) =>
    focusedPaneKey ? (s.paneForegroundAgentByPaneKey[focusedPaneKey]?.agent ?? null) : null
  )
  const processShellForeground = useAppStore((s) =>
    focusedPaneKey
      ? Boolean(s.paneForegroundAgentByPaneKey[focusedPaneKey]?.shellForeground)
      : false
  )
  // Why: a hibernated pane's session record is the freshest identity once PTY, hook, and process signals are all gone.
  const sleepingSessionAgent = useAppStore((s) =>
    focusedPaneKey ? (s.sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null) : null
  )

  // Focused pane's PTY; only used to reset per-process-generation signals on respawn.
  const ptyId = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const activeLeafId = layout?.activeLeafId
    const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
    if (leafPty) {
      return leafPty
    }
    const ptyIds = s.ptyIdsByTabId[tab.id] ?? []
    return ptyIds.length === 1 ? ptyIds[0]! : null
  })
  // Why: with no layout to place a completed row, only a single-pane tab may treat it as focused-pane exit evidence.
  const completedHookScopeKnown = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    if (layout?.activeLeafId && isTerminalLeafId(layout.activeLeafId)) {
      return true
    }
    return (s.ptyIdsByTabId[tab.id] ?? []).length <= 1
  })
  const hasRemoteRuntimePty = useAppStore((s) =>
    hasRemoteRuntimePtyForTab(
      s.ptyIdsByTabId[tab.id],
      s.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
    )
  )
  const isRemoteWorktree = useAppStore((s) => worktreeUsesRemoteConnection(s, tab.worktreeId))
  const isRemoteLike = isRemoteWorktree || hasRemoteRuntimePty

  const [hasObservedAgentSignal, setHasObservedAgentSignal] = useState(false)
  const hasObservedAgentSignalRef = useRef(false)
  const signalGenerationRef = useRef<string | null>(null)
  const completedHookEvidence = hasCompletedHook && completedHookScopeKnown

  useEffect(() => {
    // Why: reset+re-seed in one effect so a respawn drops the stale-generation signal yet re-observes a still-live hook, not left stuck false.
    const generation = `${ptyId ?? ''}|${String(isRemoteLike)}`
    if (signalGenerationRef.current !== generation) {
      signalGenerationRef.current = generation
      hasObservedAgentSignalRef.current = false
      setHasObservedAgentSignal(false)
    }
    // Ref-gate already-observed signals: title frames rerun this effect, and redundant dispatches add SortableTab commits implicated in #185 (react-update-depth-attribution.ts).
    if (
      !hasObservedAgentSignalRef.current &&
      hasObservedTabAgentSignal({
        title: tab.title,
        launchAgent: tab.launchAgent,
        hookAgent: focusedHookAgent,
        siblingHookAgent,
        hasCompletedHook: completedHookEvidence,
        processAgent
      })
    ) {
      hasObservedAgentSignalRef.current = true
      setHasObservedAgentSignal(true)
    }
  }, [
    ptyId,
    isRemoteLike,
    focusedHookAgent,
    completedHookEvidence,
    processAgent,
    siblingHookAgent,
    tab.launchAgent,
    tab.title
  ])

  useEffect(() => {
    if (!tab.launchAgent) {
      return
    }
    // Why: AND ref with state — the ref is generation-safe this commit while state can lag one render behind a respawn.
    const launchedAgentExited = resolveLaunchedAgentExitEvidence({
      title: tab.title,
      defaultTitle: tab.defaultTitle,
      isRemote: isRemoteLike,
      hasObservedAgentSignal: hasObservedAgentSignal && hasObservedAgentSignalRef.current,
      hookAgent: focusedHookAgent,
      siblingHookAgent,
      hasCompletedHook: completedHookEvidence,
      processAgent,
      processShellForeground
    })
    if (launchedAgentExited) {
      clearTabLaunchAgent(tab.id)
    }
  }, [
    clearTabLaunchAgent,
    completedHookEvidence,
    focusedHookAgent,
    siblingHookAgent,
    hasObservedAgentSignal,
    isRemoteLike,
    processAgent,
    processShellForeground,
    tab.defaultTitle,
    tab.id,
    tab.launchAgent,
    tab.title
  ])

  return resolveTabAgentFromSignals({
    hasObservedAgentSignal,
    isRemote: isRemoteLike,
    title: tab.title,
    defaultTitle: tab.defaultTitle,
    hookAgent: focusedHookAgent,
    siblingHookAgent,
    focusedCompletedHookAgent,
    siblingCompletedHookAgent,
    processAgent,
    processShellForeground,
    sleepingSessionAgent,
    launchAgent: tab.launchAgent
  })
}
