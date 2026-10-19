import { titleShowsNoAgent } from '../../../shared/agent-detection'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import {
  resolveCompatibleAgentTypeForOwner,
  shareCompatibleTitleIdentityGroup
} from '../../../shared/agent-title-owner'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { resolvePaneAgentOwnerRecord } from '../../../shared/pane-agent-owner'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import type { TuiAgent } from '../../../shared/tui-agent'
import { agentTypeToIconAgent } from './agent-status'

/**
 * Resolves wrapper-compatible signal identity against the pane owner.
 */
export function resolveSignalAgentForLaunchOwner(
  signalAgent: TerminalAgent | null | undefined,
  ownerAgent: TerminalAgent | null,
  ownerIsLaunch = false
): TerminalAgent | null {
  if (!signalAgent) {
    return null
  }
  return agentTypeToIconAgent(
    resolveCompatibleAgentTypeForOwner(signalAgent, ownerAgent, { ownerIsLaunch }) ?? signalAgent
  )
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
  hookAgent: TerminalAgent | null
  siblingHookAgent?: TerminalAgent | null
  hasCompletedHook: boolean
  processAgent?: TerminalAgent | null
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

/**
 * Identity-first precedence: live hook > process > title > completed > sleeping
 * > launch > sibling. Same-group titles (OMP wraps Pi) are not reuse evidence.
 */
export function resolveTabAgentFromSignals(args: {
  hasObservedAgentSignal: boolean
  isRemote: boolean
  title: string
  defaultTitle?: string
  hookAgent: TerminalAgent | null
  siblingHookAgent?: TerminalAgent | null
  focusedCompletedHookAgent?: TerminalAgent | null
  siblingCompletedHookAgent?: TerminalAgent | null
  processAgent?: TerminalAgent | null
  processShellForeground?: boolean
  sleepingSessionAgent?: TerminalAgent | null
  launchAgent?: TuiAgent
}): TerminalAgent | null {
  const launchAgent = args.launchAgent ?? null
  // Durable focused-pane owner (launch intent → hook → session); focused-pane-scoped so a sibling can't re-own the focused title (would mislabel a Pi pane as OMP).
  const ownerRecord = resolvePaneAgentOwnerRecord({
    launchAgent,
    hookAgent: args.hookAgent,
    completedHookAgent: args.focusedCompletedHookAgent,
    sleepingSessionAgent: args.sleepingSessionAgent
  })
  const owner = agentTypeToIconAgent(ownerRecord?.agent)
  const ownerIsLaunch = ownerRecord?.ownerIsLaunch === true

  // The live/idle split governs title override; siblings normalize against launch intent only.
  const liveFocusedIdentity = resolveSignalAgentForLaunchOwner(args.hookAgent, owner, ownerIsLaunch)
  const liveSiblingIdentity = resolveSignalAgentForLaunchOwner(
    args.siblingHookAgent,
    launchAgent,
    Boolean(launchAgent)
  )
  // Why: OSC 133;D proves this local pane returned to shell, so the idle identity is stale; remote titles lag runtime, so keep it there.
  const processProvesShell = !args.isRemote && args.processShellForeground === true
  const hasCompletedHook = (args.focusedCompletedHookAgent ?? null) !== null
  const noAgentTitle = titleShowsNoAgent(args.title, args.defaultTitle)
  const idleIdentitySuppressed =
    !args.isRemote && (noAgentTitle || processProvesShell) && hasCompletedHook
  const idleFocusedIdentity = idleIdentitySuppressed
    ? null
    : resolveSignalAgentForLaunchOwner(args.focusedCompletedHookAgent, owner, ownerIsLaunch)
  // Why: idleIdentitySuppressed is the FOCUSED pane's exit evidence, so it must not clear a sibling's idle identity.
  const idleSiblingIdentity = resolveSignalAgentForLaunchOwner(
    args.siblingCompletedHookAgent,
    launchAgent,
    Boolean(launchAgent)
  )
  const sleepingSessionAgent = args.sleepingSessionAgent ?? null

  // Title carries identity only as a reuse override (names a DIFFERENT-group agent) or a legacy standalone id when no hook — same-group titles say nothing (OMP wraps Pi), so the record wins.
  const rawTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(rawTitleAgent, owner, ownerIsLaunch)
  const priorIdentity = idleFocusedIdentity ?? launchAgent
  const nativeOpenCodeTitle = explicitTitleAgent === 'opencode' && isOpenCodeNativeTitle(args.title)
  // Why: a "claude" token in another agent's task text is a mention, not identity, so it must
  // not take a pane from its known owner — only a title that PRESENTS Claude may (#8940).
  const titleClaimsIdentity =
    explicitTitleAgent !== 'claude' || isClaudeIdentityFrameTitle(args.title)
  // Why: native OpenCode titles can reclaim stale launch intent before any observed hook signal.
  // Raw title group, not the fallback-rewritten agent: inferred Pi owners would otherwise treat an OMP wrapper title as a different identity.
  const titleReclaimsReusedPane =
    priorIdentity !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== priorIdentity &&
    !shareCompatibleTitleIdentityGroup(rawTitleAgent, priorIdentity) &&
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
  // Exit evidence also retires hibernation occupancy; a stale sleeping record must not
  // repopulate the tab icon after /exit has returned the pane to a local shell.
  const activeSleepingSessionAgent =
    launchedAgentExited || processProvesShell ? null : sleepingSessionAgent
  // Why: re-own the foreground process within its title-identity group so OMP's nested pi (shell → omp → pi) can't flip an OMP-owned tab's icon.
  const processAgent = resolveSignalAgentForLaunchOwner(args.processAgent, owner, ownerIsLaunch)
  return (
    liveFocusedIdentity ??
    processAgent ??
    titleAgent ??
    idleFocusedIdentity ??
    activeSleepingSessionAgent ??
    activeLaunchAgent ??
    liveSiblingIdentity ??
    idleSiblingIdentity
  )
}
