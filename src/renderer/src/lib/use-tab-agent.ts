import { useCallback, useSyncExternalStore } from 'react'
import { getTabAgentObservation, subscribeTabAgentObservation } from './tab-agent-exit-owner'
import { useAppStore } from '@/store'
import { titleShowsNoAgent, resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'
export { resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import { resolveSignalAgentForLaunchOwner } from './tab-agent-from-signals'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { resolvePaneAgentOwner } from '../../../shared/pane-agent-owner'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import type { TuiAgent } from '../../../shared/tui-agent'
import { agentTypeToIconAgent } from './agent-status'

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
  const owner = agentTypeToIconAgent(
    resolvePaneAgentOwner({
      launchAgent,
      hookAgent: args.hookAgent,
      completedHookAgent: args.focusedCompletedHookAgent,
      sleepingSessionAgent: args.sleepingSessionAgent
    })
  )

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
export function useTabAgent(tab: TerminalTab): TerminalAgent | null {
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

  const hasRemoteRuntimePty = useAppStore((s) =>
    hasRemoteRuntimePtyForTab(
      s.ptyIdsByTabId[tab.id],
      s.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
    )
  )
  const isRemoteWorktree = useAppStore((s) => worktreeUsesRemoteConnection(s, tab.worktreeId))
  const isRemoteLike = isRemoteWorktree || hasRemoteRuntimePty

  const subscribe = useCallback(
    (listener: () => void) => subscribeTabAgentObservation(tab.id, listener),
    [tab.id]
  )
  const snapshot = useCallback(() => getTabAgentObservation(tab.id), [tab.id])
  const hasObservedAgentSignal = useSyncExternalStore(subscribe, snapshot, snapshot)

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
