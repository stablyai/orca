import { isShellProcess } from '../../../shared/agent-detection'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import type { TuiAgent } from '../../../shared/types'

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

/**
 * Identity-first tab-agent resolution (hook > process > title > completed >
 * sleeping > launch > sibling). Pure — the React hook gathers signals and calls this.
 */
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

  // Title carries identity only as a reuse override (names a DIFFERENT-group agent) or a legacy standalone id when no hook — same-group titles say nothing (OMP wraps Pi), so the record wins.
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(
    resolveExplicitTerminalTitleAgentType(args.title),
    owner
  )
  const priorIdentity = idleFocusedIdentity ?? activeLaunchAgent
  const nativeOpenCodeTitle = explicitTitleAgent === 'opencode' && isOpenCodeNativeTitle(args.title)
  // Why (#8478): native `OC |` is provider identity for pane reuse — durable while the frame
  // remains, including after process observation and under a non-OpenCode launch (#13341 still
  // fences other cross-group nested titles/processes).
  const openCodeNativeReclaim =
    nativeOpenCodeTitle &&
    (activeLaunchAgent === null || activeLaunchAgent !== 'opencode') &&
    (priorIdentity === null || priorIdentity !== 'opencode')
  // Why: re-own the foreground process within its title-identity group so OMP's nested pi (shell → omp → pi) can't flip an OMP-owned tab's icon.
  const processAgentRaw = resolveSignalAgentForLaunchOwner(args.processAgent, owner)
  // Why (#13341): Claude↔Codex nested CLIs become the local foreground process while the
  // parent session still owns the pane. Do not let that child process rebrand the icon
  // until launch ownership has exited (then process may name a genuine reuse).
  // Why (#8478): after OC| reclaim, a launch-matching process must not undo OpenCode.
  const processAgent =
    openCodeNativeReclaim && processAgentRaw && processAgentRaw !== 'opencode'
      ? null
      : activeLaunchAgent && processAgentRaw && processAgentRaw !== activeLaunchAgent
        ? null
        : processAgentRaw
  // Why: a "claude" token in another agent's task text is a mention, not identity, so it must
  // not take a pane from its known owner — only a title that PRESENTS Claude may (#8940).
  const titleClaimsIdentity =
    explicitTitleAgent !== 'claude' || isClaudeIdentityFrameTitle(args.title)
  // Why (#13341): nested child titles are not pane reuse while launch ownership is active —
  // except native OC| (#8478), which is provider identity, not a nested CLI.
  const titleReclaimsReusedPane =
    priorIdentity !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== priorIdentity &&
    titleClaimsIdentity &&
    (!activeLaunchAgent || nativeOpenCodeTitle) &&
    (args.hasObservedAgentSignal || hasCompletedHook || nativeOpenCodeTitle)
  // Why: native OpenCode titles lack a provider generation and cannot displace durable ownership.
  const titleAgent =
    processProvesShell ||
    sleepingSessionAgent ||
    (nativeOpenCodeTitle && idleFocusedIdentity !== null)
      ? null
      : openCodeNativeReclaim || titleReclaimsReusedPane
        ? explicitTitleAgent
        : priorIdentity
          ? null
          : explicitTitleAgent

  // Identity-first precedence (see useTabAgent JSDoc): live hook > process > title > completed > sleeping > launch > sibling.
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
