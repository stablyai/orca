import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { useAppStore } from '@/store/index'
import { buildAgentResumeStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import {
  resolveRuntimeHostReportedPlatform,
  resolveRuntimeHostTerminalWindowsShell,
  resolveSshHostReportedPlatform,
  resolveAgentResumeLaunchTarget
} from '@/lib/agent-session/resume/agent-resume-launch-target'
import type { AgentResumeLaunchTarget } from '@/lib/agent-session/resume/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import { isSessionHeldByAnotherPane } from '@/lib/agent-session/identity/claude-session-pane-holders'
import { warnSessionsLeftBehind } from '@/lib/provider-accounts/claude-account-switch-notices'
import { discoveredRestartAccountLabel } from '@/lib/agent-session/accounts/claude/claude-pane-session-lookup'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { AGENT_SESSION_ACCOUNT_SWITCH_TERMINAL_CONTINUATION_MESSAGE } from '../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { resolveResumeLaunchRecipe } from '../../../../../shared/agent-launch/choices/resume-launch-recipe'
import { resolveAgentLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { findOptionOccurrence } from '../../../../../shared/cli/command-option-occurrence'
import type { AppState } from '@/store/types'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'

export type AgentAccountRestartStartup = {
  command: string
  startupCommandDelivery: 'shell-ready'
  launchAgent: AccountRestartAgent
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
}

type AccountRestartPane = {
  tabId: string
  leafId: string
  worktreeId: string
  shellOverride?: string
}

type AccountRestartTarget = Pick<AccountRestartPane, 'worktreeId' | 'shellOverride'>

const CLAUDE_LAUNCH_FLAGS = [
  ['model', ['--model']],
  ['effort', ['--effort']],
  ['permissionMode', ['--permission-mode', '--dangerously-skip-permissions']]
] as const

function withoutFlagsNamedIn(
  session: AgentProviderSessionMetadata,
  texts: readonly (string | null | undefined)[],
  shell: AgentStartupShell
): AgentProviderSessionMetadata {
  const tokens = texts.flatMap((text) => {
    const parsed = text ? tokenizeStartupCommand(text, shell) : null
    return parsed?.ok ? parsed.tokens : []
  })
  const kept = { ...session }
  for (const [field, aliases] of CLAUDE_LAUNCH_FLAGS) {
    if (findOptionOccurrence(tokens, aliases, true, [], 0, false)) {
      delete kept[field]
    }
  }
  return kept
}

/**
 * The resume startup for the pane's own session, or null when it has none to name.
 * Capture it before restart clears the old pane's status.
 */
export function resolveAgentAccountRestartResumeStartup(
  agent: AccountRestartAgent,
  args: AccountRestartPane,
  discovered?: AgentProviderSessionMetadata,
  continueWork = false
): AgentAccountRestartStartup | null {
  const state = useAppStore.getState()
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const entry = state.agentStatusByPaneKey.get(paneKey)
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const agentType =
    entry?.agentType ?? sleeping?.agent ?? (agent === 'claude' && discovered ? agent : undefined)
  if (agentType !== agent) {
    return null
  }
  const sleepingSession = normalizeAgentProviderSession(
    sleeping?.agent === agent ? sleeping.providerSession : undefined
  )
  const sleepingMatchingLookup =
    discovered && sleepingSession?.id !== discovered.id ? null : sleepingSession
  const recorded = normalizeAgentProviderSession(entry?.providerSession) ?? sleepingMatchingLookup
  const providerSession = recorded ?? (agent === 'claude' ? discovered : undefined)
  if (!providerSession) {
    return null
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  // Why Codex only: a WSL Claude resume reads the guest's selected-account pointer at launch.
  if (
    agent === 'codex' &&
    projectRuntime?.status === 'resolved' &&
    projectRuntime.runtime.kind === 'wsl'
  ) {
    return null
  }
  // A live invocation takes the one decision's answer, none included.
  const launchConfig = entry
    ? state.getAgentLaunchConfigForStatusEntry(entry)
    : sleeping?.agent === agent && sleepingMatchingLookup !== null
      ? sleeping.launchConfig
      : undefined
  const resumeTarget = resolveAccountRestartLaunchTarget(state, args, projectRuntime)
  const cmdOverrides = state.settings?.agentCmdOverrides ?? {}
  const session = recorded
    ? providerSession
    : withoutFlagsNamedIn(
        providerSession,
        [launchConfig?.agentCommand?.trim() || cmdOverrides.claude, launchConfig?.agentArgs],
        resolveStartupShell(resumeTarget.platform, resumeTarget.shell)
      )
  const startupPlan = buildAgentResumeStartupPlan({
    agent,
    providerSession: session,
    cmdOverrides,
    ...resolveResumeLaunchRecipe(launchConfig, agent, session),
    platform: resumeTarget.platform,
    agentHostPlatform: resumeTarget.agentHostPlatform,
    shell: resumeTarget.shell,
    prompt:
      agent === 'claude' && continueWork
        ? AGENT_SESSION_ACCOUNT_SWITCH_TERMINAL_CONTINUATION_MESSAGE
        : null,
    // Both restart executors spawn in the tab's start folder.
    launchCwd:
      state.tabsByWorktree[args.worktreeId]?.find((tab) => tab.id === args.tabId)?.startupCwd ??
      state.getKnownWorktreeById(
        args.worktreeId,
        getExecutionHostIdForWorktree(state, args.worktreeId)
      )?.path
  })
  if (!startupPlan) {
    return null
  }
  return {
    startupCommandDelivery: 'shell-ready',
    launchAgent: agent,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    // Main repins launch home only when the spawn names its resumed session; keep that identity with the account move.
    // Why not a looked-up session: main would seed its old transcript path onto the restarted pane and decide the next switch by it.
    ...(recorded ? { resumeProviderSession: recorded } : {})
  }
}

/** Account-switch startup: Codex can relaunch fresh; Claude requires its recorded conversation. */
export function buildPaneAccountRestartStartup(
  agent: AccountRestartAgent,
  args: AccountRestartPane,
  discovered?: AgentProviderSessionMetadata,
  continueWork = false,
  warnsWhenHeld = false
): AgentAccountRestartStartup | null {
  const resume = resolveAgentAccountRestartResumeStartup(agent, args, discovered, continueWork)
  const sessionId = resume && (resume.resumeProviderSession ?? discovered)?.id
  // Why here: another pane may have resumed the session since the restart was queued.
  if (
    agent === 'claude' &&
    sessionId &&
    isSessionHeldByAnotherPane(
      useAppStore.getState(),
      makePaneKey(args.tabId, args.leafId),
      sessionId
    )
  ) {
    if (warnsWhenHeld) {
      warnSessionsLeftBehind(1, discoveredRestartAccountLabel())
    }
    return null
  }
  return resume ?? (agent === 'codex' ? buildCodexAccountRestartStartup(args) : null)
}

export function buildCodexAccountRestartStartup(
  args: AccountRestartTarget
): AgentAccountRestartStartup {
  const state = useAppStore.getState()
  const target = resolveAccountRestartLaunchTarget(
    state,
    args,
    getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  )
  const command = resolveAgentLaunchCommand({
    agent: 'codex',
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    platform: target.platform,
    agentHostPlatform: target.agentHostPlatform,
    shell: resolveStartupShell(target.platform, target.shell)
  })
  if (!command.ok) {
    throw new Error(command.error)
  }
  return {
    command: command.command,
    startupCommandDelivery: 'shell-ready',
    launchAgent: 'codex'
  }
}

function resolveAccountRestartLaunchTarget(
  state: AppState,
  args: AccountRestartTarget,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): AgentResumeLaunchTarget {
  const executionHostId = getExecutionHostIdForWorktree(state, args.worktreeId)
  const worktree = state.getKnownWorktreeById(args.worktreeId, executionHostId)
  const repo = worktree
    ? state.repos.find((entry) => repoMatchesHostIdentity(entry, worktree.repoId, executionHostId))
    : null
  // Why: a folder or nested-SSH workspace on a server runs on its SSH target, not the server.
  const connectionId = repo?.connectionId ?? getConnectionIdFromState(state, args.worktreeId)
  return resolveAgentResumeLaunchTarget({
    projectRuntime,
    connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: args.shellOverride,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      executionHostId,
      runtimeEnvironmentIdUnlessTwin(state, args.worktreeId),
      connectionId
    ),
    runtimeHostPlatform: resolveRuntimeHostReportedPlatform(state, executionHostId),
    runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(state, executionHostId)
  })
}
