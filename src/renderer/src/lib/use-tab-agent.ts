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
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

// A shell name, or the tab's neutral default title — where Orca's
// inferred-interrupt reset parks it. Blank titles are no evidence either way.
function titleShowsNoAgent(title: string, defaultTitle?: string): boolean {
  const trimmed = title.trim()
  return trimmed.length > 0 && (isShellProcess(trimmed) || trimmed === defaultTitle?.trim())
}

/**
 * Resolves wrapper-compatible signal identity against the launch owner.
 */
function resolveSignalAgentForLaunchOwner(
  signalAgent: TuiAgent | null | undefined,
  launchAgent: TuiAgent | null
): TuiAgent | null {
  if (!signalAgent) {
    return null
  }
  return (resolveCompatibleAgentTypeForOwner(signalAgent, launchAgent) ?? signalAgent) as TuiAgent
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
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const launchAgent = args.launchAgent ?? null
  // The focused pane's durable agent owner: launch intent first, then this
  // pane's own host-stamped hook identity (live or completed), then its
  // hibernated session record. It anchors every identity decision for THIS pane
  // — it re-owns ambiguous Pi-compatible wrapper titles (OMP emits Pi's frames)
  // and keeps a mirrored or restored pane, which dropped its host-owned
  // launchAgent, resolving through the durable record instead of the title.
  // Why: strictly focused-pane-scoped — a sibling split-pane's identity says
  // nothing about which Pi-variant this pane runs, so it must not re-own the
  // focused title (it would mislabel a genuine Pi pane as its sibling's OMP).
  const owner = resolvePaneAgentOwner({
    launchAgent,
    hookAgent: args.hookAgent,
    completedHookAgent: args.focusedCompletedHookAgent,
    sleepingSessionAgent: args.sleepingSessionAgent
  }) as TuiAgent | null

  // A pane's identity comes from its hook record regardless of activity state —
  // being idle between turns must not erase which agent is here. We keep the
  // live/idle split only because it governs how a title may override identity: a
  // LIVE hook is ground truth (a title never overrides it), while an IDLE record
  // is durable but a cross-group title can reclaim a pane reused for a different
  // agent. Sibling identities normalize against launchAgent only (the tab's
  // shared launch intent), never the focused pane's own hook identity.
  const liveFocusedIdentity = resolveSignalAgentForLaunchOwner(args.hookAgent, owner)
  const liveSiblingIdentity = resolveSignalAgentForLaunchOwner(args.siblingHookAgent, launchAgent)
  // Why: OSC 133;D proved this local pane's foreground is back at the shell, so
  // the finished agent's idle identity is stale and must stop painting the tab.
  // Remote titles lag their runtime, so keep the idle identity there.
  const processProvesShell = !args.isRemote && args.processShellForeground === true
  const hasCompletedHook = (args.focusedCompletedHookAgent ?? null) !== null
  const noAgentTitle = titleShowsNoAgent(args.title, args.defaultTitle)
  const idleIdentitySuppressed =
    !args.isRemote && (noAgentTitle || processProvesShell) && hasCompletedHook
  const idleFocusedIdentity = idleIdentitySuppressed
    ? null
    : resolveSignalAgentForLaunchOwner(args.focusedCompletedHookAgent, owner)
  // Why: `idleIdentitySuppressed` is the FOCUSED pane's own exit evidence, so it
  // must not clear a sibling split-pane's idle identity — a focused pane back at
  // its shell says nothing about whether the sibling's agent has exited.
  const idleSiblingIdentity = resolveSignalAgentForLaunchOwner(
    args.siblingCompletedHookAgent,
    launchAgent
  )

  // The title carries identity in only two roles: (a) a reuse override — it
  // names a DIFFERENT-group agent than the pane's known identity, proving the
  // pane was reused for a new agent — or (b) a legacy standalone identity when
  // the pane has no hook at all. Within the same title-identity group it says
  // nothing (OMP wraps Pi and emits identical frames), so the durable record
  // wins; re-owning explicitTitleAgent through `owner` enforces that.
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(
    resolveExplicitTerminalTitleAgentType(args.title),
    owner
  )
  const priorIdentity = idleFocusedIdentity ?? launchAgent
  // Why: a completed hook is itself proof the pane has shown activity, so it
  // arms the reuse override without waiting for `hasObservedAgentSignal` — which
  // starts false for one mount commit and would otherwise flash the exited
  // agent's idle identity before the new (hookless) agent's title reclaims.
  const titleReclaimsReusedPane =
    priorIdentity !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== priorIdentity &&
    (args.hasObservedAgentSignal || hasCompletedHook)
  const titleAgent = processProvesShell
    ? null
    : titleReclaimsReusedPane
      ? explicitTitleAgent
      : priorIdentity
        ? null
        : explicitTitleAgent

  const launchedAgentExited = resolveLaunchedAgentExitEvidence({
    title: args.title,
    defaultTitle: args.defaultTitle,
    isRemote: args.isRemote,
    hasObservedAgentSignal: args.hasObservedAgentSignal,
    hookAgent: liveFocusedIdentity,
    siblingHookAgent: liveSiblingIdentity,
    hasCompletedHook,
    processAgent: args.processAgent,
    processShellForeground: args.processShellForeground
  })
  const activeLaunchAgent = launchedAgentExited ? null : launchAgent
  const processAgent = args.processAgent ?? null
  const sleepingSessionAgent = args.sleepingSessionAgent ?? null
  // Identity-first precedence. The live focused hook is ground truth while the
  // agent works; process identity covers agents with neither hook nor title; the
  // title then acts only in its reuse-override / legacy roles; and the pane's
  // durable idle identity — the record for an agent that ran here and went idle —
  // ranks above the hibernated session, the launch bootstrap, and sibling panes.
  return (
    liveFocusedIdentity ??
    processAgent ??
    titleAgent ??
    idleFocusedIdentity ??
    sleepingSessionAgent ??
    activeLaunchAgent ??
    liveSiblingIdentity ??
    idleSiblingIdentity
  )
}

/**
 * Resolve which coding-harness agent a terminal tab is running, for its tab-bar
 * icon. Identity flows through the same already-computed state as the sidebar
 * agent rows — no foreground probing. It is a pane's IDENTITY, kept separate
 * from its activity state: a hook record identifies the pane whether the agent
 * is working or idle. Identity-first precedence:
 *
 * 1. Live focused hook — provider identity from native integrations while the
 *    agent is actively working; ground truth, never overridden by a title.
 * 2. Process identity — the recognized foreground process, read at OSC 133
 *    command boundaries (local panes only); covers agents that emit neither
 *    hooks nor titles, and its shell-foreground mark is title-independent exit
 *    evidence.
 * 3. Title — only as a reuse override (it names a DIFFERENT-group agent than the
 *    pane's known identity, proving reuse) or as a legacy standalone identity
 *    when the pane has no hook. Within the same title-identity group it carries
 *    no identity (OMP wraps Pi with identical frames), so the record wins.
 * 4. Idle focused identity — the pane's own hook record after the agent went
 *    idle between turns; the durable answer to "which agent is this" once the
 *    live hook, process, and any reuse-title are absent. Suppressed on a local
 *    pane once OSC 133;D proves the agent exited.
 * 5. Sleeping session identity — a hibernated pane's captured session record.
 * 6. launchAgent — what Orca launched here; the bootstrap before any hook, hook
 *    record, or process signal exists, cleared once exit evidence shows it left.
 * 7. Sibling-pane identity (live, then idle) — split-tab fallback.
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
  // Why: a hibernated pane's persisted session record is pane-scoped evidence of
  // which agent actually ran here — the freshest identity once the PTY, hook,
  // and process signals are all gone, and proof a stale launchAgent was reused.
  const sleepingSessionAgent = useAppStore((s) =>
    focusedPaneKey ? (s.sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null) : null
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
    sleepingSessionAgent,
    launchAgent: tab.launchAgent
  })
}
