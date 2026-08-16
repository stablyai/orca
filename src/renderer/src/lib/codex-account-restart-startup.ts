import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
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
import { CODEX_ACCOUNT_RESTART_STARTUP } from './codex-session-restart'

export type CodexAccountRestartStartup = {
  command: string
  startupCommandDelivery: 'shell-ready'
  launchAgent: 'codex'
  codexAccountSwitchRestart: true
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
}

/**
 * The startup an account-switch restart runs.
 *
 * Why not a plain `codex`: relaunching the CLI with no argv starts a brand new
 * conversation. Moving the pane's `CODEX_HOME` to the selected account only
 * decides which account the new session belongs to — the conversation follows
 * just when the relaunch asks for it by id, which is what the restart card
 * promises. Main has already listed the rollout under the selected account by
 * the time the CLI reads it.
 *
 * Falls back to the bare restart when the pane has no resumable Codex session
 * (nothing was running, or the agent never reported one), because a resume argv
 * for a session that does not exist fails the launch outright.
 */
export function buildCodexAccountRestartStartup(args: {
  tabId: string
  leafId: string
  worktreeId: string
  shellOverride?: string
}): CodexAccountRestartStartup {
  const state = useAppStore.getState()
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const entry = state.agentStatusByPaneKey[paneKey]
  // Why the sleeping record is consulted too: agentStatusByPaneKey is in-memory
  // only, so a pane whose shell outlived an Orca restart has no live entry until
  // Codex emits its next hook — and a restart in that window would relaunch bare
  // while the card promised the conversation would carry.
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const agentType = entry?.agentType ?? sleeping?.agent
  if (agentType !== 'codex') {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const providerSession =
    normalizeAgentProviderSession(entry?.providerSession) ??
    normalizeAgentProviderSession(sleeping?.providerSession)
  if (!providerSession) {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  // Why WSL keeps the bare relaunch: main repins and links the rollout for host
  // lanes only, so a WSL pane would ask its new account's home to resume a
  // conversation that home does not list — a blank session where a fresh one at
  // least starts clean. See prepareCodexSessionResumeForLaunch.
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const launchConfig =
    (entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ?? sleeping?.launchConfig
  // Why the pane's own shell: the resume argv is quoted for the shell that will
  // run it, and a tab can override the machine's default.
  const resumeTarget = resolveAgentResumeLaunchTarget({
    projectRuntime,
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, args.worktreeId),
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: args.shellOverride
  })
  const startupPlan = buildAgentResumeStartupPlan({
    agent: 'codex',
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs('codex', state.settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv('codex', state.settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
  })
  if (!startupPlan) {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  return {
    ...CODEX_ACCOUNT_RESTART_STARTUP,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    // Why it rides along: main only repins the launch home for a spawn that
    // names the session it is resuming, so dropping this drops the account move.
    resumeProviderSession: providerSession
  }
}
