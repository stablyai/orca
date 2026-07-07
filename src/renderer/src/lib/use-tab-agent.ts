import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { isShellProcess } from '../../../shared/agent-detection'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

// A shell name, or the tab's neutral default title — where Orca's
// inferred-interrupt reset parks it. Blank titles are no evidence either way.
function titleShowsNoAgent(title: string, defaultTitle?: string): boolean {
  const trimmed = title.trim()
  return trimmed.length > 0 && (isShellProcess(trimmed) || trimmed === defaultTitle?.trim())
}

/**
 * Probe-free evidence that a launched agent exited: the title shows no agent,
 * no live hook row remains in the tab, and either the hook completed or
 * previously observed activity vanished. The vanished-activity disjunct is
 * local-only: remote rows also drop on transport blips that say nothing about
 * the process.
 */
export function resolveLaunchedAgentExitEvidence(args: {
  title: string
  defaultTitle?: string
  isRemote: boolean
  hasObservedAgentSignal: boolean
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  hasCompletedHook: boolean
  processAgent?: TuiAgent | null
  processShellForeground?: boolean
}): boolean {
  if (args.hookAgent || args.siblingHookAgent || args.processAgent) {
    return false
  }
  // Why: OSC 133;D proved the foreground returned to the shell — process-grade
  // exit evidence that doesn't depend on the agent leaving a clean title.
  // Local-only by construction (remote panes have no shell-foreground producer);
  // the gate keeps the invariant even for out-of-pipeline callers.
  if (!args.isRemote && args.processShellForeground && args.hasObservedAgentSignal) {
    return true
  }
  if (!titleShowsNoAgent(args.title, args.defaultTitle)) {
    return false
  }
  return args.hasCompletedHook || (!args.isRemote && args.hasObservedAgentSignal)
}

export function resolveTabAgentFromSignals(args: {
  hasObservedAgentSignal: boolean
  isRemote: boolean
  title: string
  defaultTitle?: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  siblingCompletedHookAgent?: TuiAgent | null
  processAgent?: TuiAgent | null
  processShellForeground?: boolean
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const launchAgent = args.launchAgent ?? null
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  // Why: when a pane is reused for a different agent, its launchAgent goes stale.
  // A live title that explicitly names a *different* agent, once the pane has
  // shown any activity, overrides that stale launch identity so the tab icon
  // tracks what is actually running (codex launch reused for claude, etc.).
  // Why: OSC 133;D proved this local pane's foreground is back at the shell,
  // so any title-derived identity is stale by definition — a TUI that died
  // with a stuck title must not keep painting the tab through the title layer.
  const processProvesShell = !args.isRemote && args.processShellForeground === true
  const titleOverridesLaunch =
    launchAgent !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== launchAgent &&
    args.hasObservedAgentSignal
  const titleAgent = processProvesShell
    ? null
    : titleOverridesLaunch
      ? explicitTitleAgent
      : launchAgent
        ? null
        : explicitTitleAgent
  const hasCompletedHook = (args.focusedCompletedHookAgent ?? null) !== null
  const noAgentTitle = titleShowsNoAgent(args.title, args.defaultTitle)
  // Why: remote pane titles can lag their runtime, so keep the last completed
  // hook identity instead of flashing unknown when the title reads as a shell.
  const completedHookAgent =
    !args.isRemote && (noAgentTitle || processProvesShell) && hasCompletedHook
      ? null
      : (args.focusedCompletedHookAgent ?? args.siblingCompletedHookAgent ?? null)
  const focusedHookAgent = args.hookAgent ?? null
  const fallbackHookAgent = args.siblingHookAgent ?? completedHookAgent ?? null
  const launchedAgentExited = resolveLaunchedAgentExitEvidence({
    title: args.title,
    defaultTitle: args.defaultTitle,
    isRemote: args.isRemote,
    hasObservedAgentSignal: args.hasObservedAgentSignal,
    hookAgent: focusedHookAgent,
    siblingHookAgent: args.siblingHookAgent,
    hasCompletedHook,
    processAgent: args.processAgent,
    processShellForeground: args.processShellForeground
  })
  const activeLaunchAgent = launchedAgentExited ? null : launchAgent
  const processAgent = args.processAgent ?? null
  // Why: titleAgent ranks ahead of launch/fallback hooks because, once the
  // pane has shown activity, a live explicit title is the freshest identity
  // signal — it beats a launchAgent gone stale through pane reuse. Before any
  // activity, titleAgent is null while launchAgent exists, so launch bootstrap
  // still wins the startup window. Process identity (the recognized foreground
  // process) is ground truth below hooks — it covers agents that emit neither
  // hooks nor titles.
  return focusedHookAgent ?? processAgent ?? titleAgent ?? activeLaunchAgent ?? fallbackHookAgent
}

/**
 * Resolve which coding-harness agent a terminal tab is running, for its tab-bar
 * icon. Identity flows through the same already-computed state as the sidebar
 * agent rows — no foreground probing. Layered signals, most-authoritative
 * first:
 *
 * 1. Hook status — provider identity from native integrations; the live entry
 *    for the pane, dropped by the same OSC 133 command-finished machinery that
 *    clears the sidebar row when the process exits.
 * 2. Process identity — the recognized foreground process, read at OSC 133
 *    command boundaries (local panes only); covers agents that emit neither
 *    hooks nor titles, and its shell-foreground mark is title-independent
 *    exit evidence.
 * 3. launchAgent — what Orca launched here; instant bootstrap before hooks
 *    arrive, cleared once hook/process/title evidence shows the launched
 *    agent exited.
 * 4. Title — legacy/unknown-session fallback, and the live override when a pane
 *    is reused: once the pane has shown activity, a title that explicitly names
 *    a different agent than launchAgent wins over that stale launch identity.
 *    Otherwise it is ignored while launchAgent exists, and generic spinner-only
 *    titles never identify an agent.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const focusedHookAgent = useAppStore((s) =>
    resolveFocusedTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const siblingHookAgent = useAppStore((s) =>
    resolveSiblingTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const focusedCompletedHookAgent = useAppStore((s) =>
    resolveFocusedCompletedTabAgent(
      s.agentStatusByPaneKey,
      s.terminalLayoutsByTabId[tab.id],
      tab.id
    )
  )
  const siblingCompletedHookAgent = useAppStore((s) =>
    resolveSiblingCompletedTabAgent(
      s.agentStatusByPaneKey,
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

  // The focused pane's PTY (single-pane tabs have exactly one leaf). Only used
  // to reset per-process-generation signals when the pane is respawned.
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
  // Why: with no layout to prove which pane a completed row belongs to, only a
  // single-pane tab may treat it as focused-pane exit evidence — a sibling's
  // done row must not clear another pane's launch identity.
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
    for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      ptyIds.add(ptyId)
    }
    return [...ptyIds].some((ptyId) => parseRemoteRuntimePtyId(ptyId) !== null)
  })
  const isRemoteWorktree = useAppStore((s) => worktreeUsesRemoteConnection(s, tab.worktreeId))
  const isRemoteLike = isRemoteWorktree || hasRemoteRuntimePty

  const [hasObservedAgentSignal, setHasObservedAgentSignal] = useState(false)
  const hasObservedAgentSignalRef = useRef(false)
  const signalGenerationRef = useRef<string | null>(null)
  const completedHookEvidence = hasCompletedHook && completedHookScopeKnown

  useEffect(() => {
    // Why: reset and re-seed in one effect so a pane respawn both invalidates
    // the previous generation's signal and immediately re-observes a still-live
    // hook row instead of leaving the signal stuck false.
    const generation = `${ptyId ?? ''}|${String(isRemoteLike)}`
    if (signalGenerationRef.current !== generation) {
      signalGenerationRef.current = generation
      hasObservedAgentSignalRef.current = false
      setHasObservedAgentSignal(false)
    }
    const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(tab.title)
    // Why: for launched panes, only a title naming the launched agent counts as
    // its activity — other-agent or sibling evidence must not arm exit clearing
    // for an agent that never produced evidence of its own.
    const fallbackAgentSignal = tab.launchAgent
      ? explicitTitleAgent === tab.launchAgent
      : Boolean(explicitTitleAgent || siblingHookAgent)
    // Why: a recognized foreground process is focused-pane ground truth, so it
    // arms exit clearing even for agents with no hook or title integration.
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
    // Why: AND the state with the ref — the ref is generation-safe within this
    // commit (the observe effect above already reset it), while the state can
    // lag one render behind a pane focus/respawn switch.
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
    launchAgent: tab.launchAgent
  })
}
