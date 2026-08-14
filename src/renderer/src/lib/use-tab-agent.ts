import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import {
  resolveLaunchedAgentExitEvidence,
  resolveTabAgentFromSignals
} from './tab-agent-from-signals'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

export { resolveLaunchedAgentExitEvidence, resolveTabAgentFromSignals } from './tab-agent-from-signals'

/**
 * Resolve which coding-harness agent a terminal tab is running, for its tab-bar
 * icon. A pane's IDENTITY (separate from activity state), from the same
 * already-computed state as the sidebar rows — no foreground probing.
 * Identity-first precedence:
 *
 * 1. Live focused hook — ground truth while the agent works; never title-overridden.
 * 2. Process identity — recognized foreground process (local only); re-owned within its title-identity group so OMP's nested `pi` (shell → omp → pi) can't flip the icon.
 * 3. Title — only a reuse override or legacy standalone identity; native OpenCode titles cannot displace durable ownership.
 * 4. Idle focused identity — the pane's completed hook or sidebar-retained completion; suppressed locally once OSC 133;D proves exit.
 * 5. Sleeping session identity — current provider-session ownership.
 * 6. launchAgent — bootstrap before any hook/process signal; cleared once exit evidence shows it left.
 * 7. Sibling-pane identity (live, then completed/retained) — split-tab fallback.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const focusedHookAgent = useAppStore((s) =>
    resolveFocusedTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const siblingHookAgent = useAppStore((s) =>
    resolveSiblingTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const focusedCompletedHookAgent = useAppStore(
    (s) =>
      resolveFocusedCompletedTabAgent(
        s.agentStatusByPaneKey,
        s.terminalLayoutsByTabId[tab.id],
        tab.id
      ) ??
      resolveFocusedRetainedTabAgent(
        s.retainedAgentsByPaneKey,
        s.terminalLayoutsByTabId[tab.id],
        tab.id
      )
  )
  const siblingCompletedHookAgent = useAppStore(
    (s) =>
      resolveSiblingCompletedTabAgent(
        s.agentStatusByPaneKey,
        s.terminalLayoutsByTabId[tab.id],
        tab.id
      ) ??
      resolveSiblingRetainedTabAgent(
        s.retainedAgentsByPaneKey,
        s.terminalLayoutsByTabId[tab.id],
        tab.id
      )
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
  const hasRemoteRuntimePty = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const ptyIds = new Set(s.ptyIdsByTabId[tab.id] ?? [])
    for (const id of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      ptyIds.add(id)
    }
    return [...ptyIds].some((id) => parseRemoteRuntimePtyId(id) !== null)
  })
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
    const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(tab.title)
    // Why: only a title naming the launched agent arms its exit clearing — sibling/other-agent evidence must not.
    const fallbackAgentSignal = tab.launchAgent
      ? explicitTitleAgent === tab.launchAgent
      : Boolean(explicitTitleAgent || siblingHookAgent)
    // Why: a recognized foreground process arms exit clearing even for agents with no hook or title integration.
    if (focusedHookAgent || completedHookEvidence || processAgent || fallbackAgentSignal) {
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
