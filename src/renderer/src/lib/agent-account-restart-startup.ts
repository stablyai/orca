import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { useAppStore, type AppState } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveRuntimeHostReportedPlatform,
  resolveRuntimeHostTerminalWindowsShell,
  resolveSshHostReportedPlatform,
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { resolveAgentLaunchCommand } from '../../../shared/tui-agent-launch-command'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'

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

/**
 * The resume startup for the pane's own session, or null when it has none to name.
 * Capture it before restart clears the old pane's status.
 */
export function resolveAgentAccountRestartResumeStartup(
  agent: AccountRestartAgent,
  args: AccountRestartPane
): AgentAccountRestartStartup | null {
  // Why: a hand-started Claude must not come back with configured defaults such as a permission bypass.
  const unrecordedLaunchUsesDefaults = agent !== 'claude'
  const state = useAppStore.getState()
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const entry = state.agentStatusByPaneKey[paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const agentType = entry?.agentType ?? sleeping?.agent
  if (agentType !== agent) {
    return null
  }
  const providerSession =
    normalizeAgentProviderSession(entry?.providerSession) ??
    normalizeAgentProviderSession(sleeping?.agent === agent ? sleeping.providerSession : undefined)
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
  const launchConfig =
    (entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
    (sleeping?.agent === agent ? sleeping.launchConfig : undefined)
  const resumeTarget = resolveAccountRestartLaunchTarget(state, args, projectRuntime)
  const startupPlan = buildAgentResumeStartupPlan({
    agent,
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : unrecordedLaunchUsesDefaults
          ? resolveTuiAgentLaunchArgs(agent, state.settings)
          : null,
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : unrecordedLaunchUsesDefaults
          ? resolveTuiAgentLaunchEnv(agent, state.settings, resumeTarget.platform)
          : null,
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    agentHostPlatform: resumeTarget.agentHostPlatform,
    shell: resumeTarget.shell,
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
    resumeProviderSession: providerSession
  }
}

/** Account-switch startup: Codex can relaunch fresh; Claude requires its recorded conversation. */
export function buildPaneAccountRestartStartup(
  agent: AccountRestartAgent,
  args: AccountRestartPane
): AgentAccountRestartStartup | null {
  const resume = resolveAgentAccountRestartResumeStartup(agent, args)
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
