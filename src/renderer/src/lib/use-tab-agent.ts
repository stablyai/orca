import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useAgentStatusSelector } from '@/store/agent-status'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { getTabAgentExitOwner } from './tab-agent-exit-owner'
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

import { titleShowsNoAgent, resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'
export { resolveLaunchedAgentExitEvidence } from './tab-agent-exit-evidence'

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

  /** Titles identify only different-group reuse or legacy hookless agents; same-group titles (OMP wrapping Pi) defer to durable records. */
  const explicitTitleAgent = resolveSignalAgentForLaunchOwner(
    resolveExplicitTerminalTitleAgentType(args.title),
    owner
  )
  const priorIdentity = idleFocusedIdentity ?? launchAgent
  const nativeOpenCodeTitle = explicitTitleAgent === 'opencode' && isOpenCodeNativeTitle(args.title)
  // A task mentioning claude cannot take another agent’s pane; only titles presenting Claude establish identity (#8940).
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

/** Resolve pane identity, separate from activity, without foreground probes: live focused hook → process (normalized to owner group) → reuse/hookless title → completed/retained focused identity → sleeping session → launch → sibling fallback. Native OpenCode titles cannot displace durable ownership; local OSC 133;D suppresses exited idle identity. */
export function useTabAgent(tab: TerminalTab, groupId?: string): TerminalAgent | null {
  const focusedHookAgent = useAgentStatusSelector(
    (s) => resolveFocusedTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id),
    undefined,
    tab.id
  )
  const siblingHookAgent = useAgentStatusSelector(
    (s) => resolveSiblingTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id),
    undefined,
    tab.id
  )
  const focusedCompletedHookAgent = useAgentStatusSelector(
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
      ),
    undefined,
    tab.id
  )
  const siblingCompletedHookAgent = useAgentStatusSelector(
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
      ),
    undefined,
    tab.id
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
  const service = getTabAgentExitOwner(getAgentStatusOwner(useAppStore))
  const subscribe = useCallback(
    (listener: () => void) => service.subscribe(tab.id, listener),
    [service, tab.id]
  )
  const read = useCallback(
    () => service.getObservation(tab.worktreeId, tab.id, groupId),
    [service, tab.worktreeId, tab.id, groupId]
  )
  const hasObservedAgentSignal = useSyncExternalStore(subscribe, read, read)

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
