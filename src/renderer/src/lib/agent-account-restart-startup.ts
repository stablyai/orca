import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveSshHostReportedPlatform,
  resolveAgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { findClaudeTranscriptProjectFolder } from '../../../shared/claude-project-dir-encoding'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isWslShellName } from '../../../shared/local-windows-terminal-runtime'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { CODEX_ACCOUNT_RESTART_STARTUP } from './codex-session-restart'

export type AgentAccountRestartStartup = {
  command: string
  startupCommandDelivery: 'shell-ready'
  launchAgent: AccountRestartAgent
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  /** The folder the session is filed under, when known; the relaunch starts there. */
  cwd?: string
}

type AccountRestartPane = {
  tabId: string
  leafId: string
  worktreeId: string
  shellOverride?: string
  /** The pane's last reported folder, which may be a sub-folder of the session's own. */
  paneCwd?: string
}

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
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const launchConfig =
    (entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
    (sleeping?.agent === agent ? sleeping.launchConfig : undefined)
  const executionHostId = getExecutionHostIdForWorktree(state, args.worktreeId)
  const resumeTarget = resolveAgentResumeLaunchTarget({
    projectRuntime,
    connectionId: repo?.connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: args.shellOverride,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      executionHostId,
      runtimeEnvironmentIdUnlessTwin(state, args.worktreeId)
    )
  })
  const startupPlan = buildAgentResumeStartupPlan({
    agent,
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : unrecordedLaunchUsesDefaults
          ? resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs)
          : null,
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : unrecordedLaunchUsesDefaults
          ? resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv)
          : null,
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
  })
  if (!startupPlan) {
    return null
  }
  // Why host-native only: WSL and remote panes report guest paths this host must not start in.
  const resumesOnThisHost =
    !repo?.connectionId &&
    parseExecutionHostId(executionHostId)?.kind === 'local' &&
    !(projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') &&
    resumeTarget.platform === CLIENT_PLATFORM &&
    !isWslShellName(args.shellOverride)
  // Why: Claude finds a session only from the folder it is filed under, which neither the pane's
  // last reported folder nor the tab's start folder has to be (#31545).
  const sessionCwd =
    agent === 'claude' && resumesOnThisHost
      ? findClaudeTranscriptProjectFolder(providerSession.transcriptPath, [
          args.paneCwd,
          state.tabsByWorktree[args.worktreeId]?.find((tab) => tab.id === args.tabId)?.startupCwd,
          worktree?.path
        ])
      : null
  return {
    startupCommandDelivery: 'shell-ready',
    launchAgent: agent,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    // Why it rides along: main only repins the launch home for a spawn that
    // names the session it is resuming, so dropping this drops the account move.
    resumeProviderSession: providerSession,
    ...(sessionCwd ? { cwd: sessionCwd } : {})
  }
}

/**
 * The startup an account-switch restart relaunches the pane with. Codex falls
 * back to a bare relaunch; Claude only ever resumes, so null means skip it.
 */
export function buildPaneAccountRestartStartup(
  agent: AccountRestartAgent,
  args: AccountRestartPane
): AgentAccountRestartStartup | null {
  const resume = resolveAgentAccountRestartResumeStartup(agent, args)
  return resume ?? (agent === 'codex' ? CODEX_ACCOUNT_RESTART_STARTUP : null)
}
