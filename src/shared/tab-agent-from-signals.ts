import { titleShowsNoAgent } from './agent-detection'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import {
  resolveCompatibleAgentTypeForOwner,
  shareCompatibleTitleIdentityGroup
} from './agent-title-owner'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { resolvePaneAgentOwnerRecord } from './pane-agent-owner'
import type { TerminalAgent } from './terminal-agent'
import type { TuiAgent } from './tui-agent'
import { agentTypeToIconAgent } from './agent-type-icon-agent'

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

/** Without probes, missing title/hook plus completion or vanished local activity proves exit. Remote activity loss can be transport blips and must not count. */
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
  /** Focused-pane ownership follows launch → hook → session; sibling ownership cannot reinterpret this title (e.g. Pi as OMP). */
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

  /** Titles identify only different-group reuse or legacy hookless agents; same-group titles (OMP wrapping Pi) defer to durable records. */
  const rawTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(rawTitleAgent, owner, ownerIsLaunch)
  const priorIdentity = idleFocusedIdentity ?? launchAgent
  const nativeOpenCodeTitle = explicitTitleAgent === 'opencode' && isOpenCodeNativeTitle(args.title)
  // Why: native OpenCode titles can reclaim stale launch intent before any observed hook signal.
  // Raw title group, not the fallback-rewritten agent: inferred Pi owners would otherwise treat an OMP wrapper title as a different identity.
  const titleReclaimsReusedPane =
    priorIdentity !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== priorIdentity &&
    !shareCompatibleTitleIdentityGroup(rawTitleAgent, priorIdentity) &&
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
  const processAgent = resolveSignalAgentForLaunchOwner(args.processAgent, owner, ownerIsLaunch)
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

/** A hook, completion or process, or a title naming the launched agent (any agent when none was launched), arms exit clearing. */
export function hasObservedTabAgentSignal(args: {
  title: string
  launchAgent?: TuiAgent | null
  hookAgent?: TerminalAgent | null
  siblingHookAgent?: TerminalAgent | null
  hasCompletedHook: boolean
  processAgent?: TerminalAgent | null
}): boolean {
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  const fallbackAgentSignal = args.launchAgent
    ? explicitTitleAgent === args.launchAgent
    : Boolean(explicitTitleAgent || args.siblingHookAgent)
  return Boolean(
    args.hookAgent || args.hasCompletedHook || args.processAgent || fallbackAgentSignal
  )
}

/** One-shot read without useTabAgent's observation history or OSC 133;D, so local-only exit clearing does not apply. */
export function resolveTabAgentFromSignalSnapshot(
  args: Omit<
    Parameters<typeof resolveTabAgentFromSignals>[0],
    'hasObservedAgentSignal' | 'isRemote' | 'processShellForeground'
  >
): TerminalAgent | null {
  return resolveTabAgentFromSignals({
    ...args,
    hasObservedAgentSignal: hasObservedTabAgentSignal({
      ...args,
      hasCompletedHook: Boolean(args.focusedCompletedHookAgent)
    }),
    isRemote: true
  })
}
