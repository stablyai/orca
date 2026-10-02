// Temporary compatibility for panes without a live identified owner; removed by step 3.
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
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
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Resolves wrapper-compatible signal identity against the pane owner.
 */
function resolveSignalAgentForLaunchOwner(
  signalAgent: TuiAgent | null | undefined,
  ownerAgent: TuiAgent | null,
  ownerIsLaunch = false
): TuiAgent | null {
  if (!signalAgent) {
    return null
  }
  const identity = resolveCompatibleAgentTypeForOwner(signalAgent, ownerAgent, { ownerIsLaunch })
  return isTuiAgent(identity) ? identity : signalAgent
}

/**
 * Temporary compatibility decision for an unidentified launch: title shows no agent, no live
 * hook remains, and either the hook completed or observed activity vanished.
 * Vanished-activity is local-only — remote rows also drop on transport blips.
 */
export function resolveLegacyLaunchedAgentExitEvidence(args: {
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
 * Identity-first precedence: live hook > process > title > completed > sleeping
 * > launch > sibling. Same-group titles (OMP wraps Pi) are not reuse evidence.
 */
export function resolveLegacyTabAgentFromSignals(args: {
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
  const ownerRecord = resolvePaneAgentOwnerRecord({
    launchAgent,
    hookAgent: args.hookAgent,
    completedHookAgent: args.focusedCompletedHookAgent,
    sleepingSessionAgent: args.sleepingSessionAgent
  })
  const owner = isTuiAgent(ownerRecord?.agent) ? ownerRecord.agent : null
  const ownerIsLaunch = ownerRecord?.ownerIsLaunch === true

  // The live/idle split governs title override; siblings normalize against launch intent only.
  const liveFocusedIdentity = resolveSignalAgentForLaunchOwner(args.hookAgent, owner, ownerIsLaunch)
  const liveSiblingIdentity = resolveSignalAgentForLaunchOwner(
    args.siblingHookAgent,
    launchAgent,
    Boolean(launchAgent)
  )
  // Why: Legacy OSC 133;D policy clears idle identity; remote titles lag runtime, so keep it there.
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

  const launchedAgentExited = resolveLegacyLaunchedAgentExitEvidence({
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

/** Temporary until step 3: with no live identified owner only the old signal policy can decide.
 *  Every legacy gate goes through this symbol so step 3 can find and remove them together. */
export function isLegacyUnidentified(presence: AgentProcessPresence | undefined): boolean {
  return !presence?.process || presence.ended === true
}

export function applyLegacyUnidentifiedAgentSignal(
  presence: AgentProcessPresence | undefined,
  apply: () => void
): void {
  if (isLegacyUnidentified(presence)) {
    apply()
  }
}

export function applyLegacyCommandFinishedStatus(
  state: AppState,
  paneKey: string,
  entry: AgentStatusEntry | undefined,
  options?: { allowInferredInterrupt?: boolean }
): void {
  applyLegacyUnidentifiedAgentSignal(state.agentPresenceByPaneKey?.[paneKey]?.presence, () => {
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status. The
      // launch registry was still created up front, so clear it on command exit.
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const current = state.agentStatusByPaneKey[paneKey]
    if (!current) {
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    const inferredFromEntry =
      options?.allowInferredInterrupt === true &&
      current.state === 'done' &&
      current.interrupted === true &&
      current.prompt === entry.prompt &&
      current.agentType === entry.agentType &&
      current.stateHistory?.some(
        (history) =>
          history.state === entry.state &&
          history.prompt === entry.prompt &&
          history.startedAt === entry.stateStartedAt
      ) === true
    if (!unchanged && !inferredFromEntry) {
      return
    }
    state.dropAgentStatus(paneKey)
  })
}
