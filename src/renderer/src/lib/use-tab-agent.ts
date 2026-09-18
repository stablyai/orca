import { useEffect, useRef, useState } from 'react'
import { isShellProcess } from '../../../shared/agent-detection'
import { useTabAgentStoreSignals } from './tab-agent-store-signals'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'

// A shell name or the tab's neutral default title (where inferred-interrupt reset parks it); blank titles are no evidence.
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
 * Probe-free evidence a launched agent exited: title shows no agent, no live
 * hook remains, and either the hook completed or observed activity vanished.
 * Vanished-activity is local-only — remote rows also drop on transport blips.
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
  // Why: OSC 133;D (foreground back at shell) is title-independent exit evidence; local-only — remote panes have no shell-foreground producer.
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
  // Durable focused-pane owner (launch intent → hook → session); focused-pane-scoped so a sibling can't re-own the focused title (would mislabel a Pi pane as OMP).
  const owner = resolvePaneAgentOwner({
    launchAgent,
    hookAgent: args.hookAgent,
    completedHookAgent: args.focusedCompletedHookAgent,
    sleepingSessionAgent: args.sleepingSessionAgent
  }) as TuiAgent | null

  // The live/idle split governs title override; siblings normalize against launch intent only.
  const liveFocusedIdentity = resolveSignalAgentForLaunchOwner(args.hookAgent, owner)
  const liveSiblingIdentity = resolveSignalAgentForLaunchOwner(args.siblingHookAgent, launchAgent)
  // Why: OSC 133;D proves this local pane returned to shell, so the idle identity is stale; remote titles lag runtime, so keep it there.
  const processProvesShell = !args.isRemote && args.processShellForeground === true
  const hasCompletedHook = (args.focusedCompletedHookAgent ?? null) !== null
  const noAgentTitle = titleShowsNoAgent(args.title, args.defaultTitle)
  const idleIdentitySuppressed =
    !args.isRemote && (noAgentTitle || processProvesShell) && hasCompletedHook
  const idleFocusedIdentity = idleIdentitySuppressed
    ? null
    : resolveSignalAgentForLaunchOwner(args.focusedCompletedHookAgent, owner)
  // Why: idleIdentitySuppressed is the FOCUSED pane's exit evidence, so it must not clear a sibling's idle identity.
  const idleSiblingIdentity = resolveSignalAgentForLaunchOwner(
    args.siblingCompletedHookAgent,
    launchAgent
  )
  const sleepingSessionAgent = args.sleepingSessionAgent ?? null

  // Title carries identity only as a reuse override (names a DIFFERENT-group agent) or a legacy standalone id when no hook — same-group titles say nothing (OMP wraps Pi), so the record wins.
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(
    resolveExplicitTerminalTitleAgentType(args.title),
    owner
  )
  const priorIdentity = idleFocusedIdentity ?? launchAgent
  const nativeOpenCodeTitle = explicitTitleAgent === 'opencode' && isOpenCodeNativeTitle(args.title)
  // Why: a "claude" token in another agent's task text is a mention, not identity, so it must
  // not take a pane from its known owner — only a title that PRESENTS Claude may (#8940).
  const titleClaimsIdentity =
    explicitTitleAgent !== 'claude' || isClaudeIdentityFrameTitle(args.title)
  // Why: native OpenCode titles can reclaim stale launch intent before any observed hook signal.
  const titleReclaimsReusedPane =
    priorIdentity !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== priorIdentity &&
    titleClaimsIdentity &&
    (args.hasObservedAgentSignal || hasCompletedHook || nativeOpenCodeTitle)
  // Why: native OpenCode titles lack a provider generation and cannot displace durable ownership.
  const titleAgent =
    processProvesShell ||
    sleepingSessionAgent ||
    (nativeOpenCodeTitle && idleFocusedIdentity !== null)
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
  // Why: re-own the foreground process within its title-identity group so OMP's nested pi (shell → omp → pi) can't flip an OMP-owned tab's icon.
  const processAgent = resolveSignalAgentForLaunchOwner(args.processAgent, owner)
  // Identity-first precedence (see JSDoc): live hook > process > title > completed > sleeping > launch > sibling.
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
  // Why one subscription and not thirteen: this hook mounts once per tab-bar tab AND once
  // per session-grid card, so its listener count multiplies by every mounted surface.
  const {
    focusedHookAgent,
    siblingHookAgent,
    focusedCompletedHookAgent,
    siblingCompletedHookAgent,
    processAgent,
    processShellForeground,
    sleepingSessionAgent,
    ptyId,
    completedHookScopeKnown,
    isRemoteLike,
    clearTabLaunchAgent
  } = useTabAgentStoreSignals(tab.id, tab.worktreeId)
  const hasCompletedHook = focusedCompletedHookAgent !== null

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
    // Why the ref gate: this effect re-runs on every title frame, and re-dispatching an
    // already-true flag costs SortableTab a second commit each time — and names its fiber
    // in #185 stacks driven elsewhere (see shared/react-update-depth-attribution.ts).
    if (
      !hasObservedAgentSignalRef.current &&
      (focusedHookAgent || completedHookEvidence || processAgent || fallbackAgentSignal)
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
