import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
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
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { resolveResumeLaunchRecipe } from '../../../../../shared/agent-launch/choices/resume-launch-recipe'
import { resolveAgentLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command'
import { resolveStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
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

export type AgentAccountRestartResumeInput = {
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
} | null

export function captureAgentAccountRestartResumeInput(
  state: AppState,
  agent: AccountRestartAgent,
  args: AccountRestartPane
): AgentAccountRestartResumeInput {
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const entry = state.agentStatusByPaneKey[paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  if ((entry?.agentType ?? sleeping?.agent) !== agent) {
    return null
  }
  const providerSession =
    normalizeAgentProviderSession(entry?.providerSession) ??
    normalizeAgentProviderSession(sleeping?.agent === agent ? sleeping.providerSession : undefined)
  if (!providerSession) {
    return null
  }
  const launchConfig = entry
    ? state.getAgentLaunchConfigForStatusEntry(entry)
    : sleeping?.agent === agent
      ? sleeping.launchConfig
      : undefined
  return structuredClone({ providerSession, launchConfig })
}

/** Capture before teardown; retry a build error using the same conversation inputs. */
export function resolveAgentAccountRestartResumeStartup(
  state: AppState,
  agent: AccountRestartAgent,
  args: AccountRestartPane,
  input?: AgentAccountRestartResumeInput
): AgentAccountRestartStartup | null {
  const captured =
    input === undefined ? captureAgentAccountRestartResumeInput(state, agent, args) : input
  if (!captured) {
    return null
  }
  const { providerSession, launchConfig } = captured
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  // Why Codex only: a WSL Claude resume reads the guest's selected-account pointer at launch.
  if (
    agent === 'codex' &&
    projectRuntime?.status === 'resolved' &&
    projectRuntime.runtime.kind === 'wsl'
  ) {
    if (input) {
      throw new Error('terminal_account_restart_resume_unsupported')
    }
    return null
  }
  const resumeTarget = resolveAccountRestartLaunchTarget(state, args, projectRuntime)
  const startupPlan = buildAgentResumeStartupPlan({
    agent,
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    ...resolveResumeLaunchRecipe(launchConfig, agent, providerSession),
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
  state: AppState,
  agent: AccountRestartAgent,
  args: AccountRestartPane,
  input?: AgentAccountRestartResumeInput
): AgentAccountRestartStartup | null {
  const resume = resolveAgentAccountRestartResumeStartup(state, agent, args, input)
  if (input && !resume) {
    throw new Error('terminal_account_restart_resume_unavailable')
  }
  const sessionId = resume?.resumeProviderSession?.id
  // Why here: a queued restart runs at idle, and another pane may have resumed the session since.
  if (
    agent === 'claude' &&
    sessionId &&
    isSessionHeldByAnotherPane(state, makePaneKey(args.tabId, args.leafId), sessionId)
  ) {
    return null
  }
  return resume ?? (agent === 'codex' ? buildCodexAccountRestartStartup(state, args) : null)
}

export function buildCodexAccountRestartStartup(
  state: AppState,
  args: AccountRestartTarget
): AgentAccountRestartStartup {
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
