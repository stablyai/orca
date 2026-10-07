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
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
}

// Capture the session before restart clears the old pane’s status.
export function buildCodexAccountRestartStartup(args: {
  tabId: string
  leafId: string
  worktreeId: string
  shellOverride?: string
}): CodexAccountRestartStartup {
  const state = useAppStore.getState()
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const entry = state.agentStatusByPaneKey[paneKey]
  const sleeping = state.sleepingAgentSessionsByPaneKey[paneKey]
  const agentType = entry?.agentType ?? sleeping?.agent
  if (agentType !== 'codex') {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const providerSession =
    normalizeAgentProviderSession(entry?.providerSession) ??
    normalizeAgentProviderSession(
      sleeping?.agent === 'codex' ? sleeping.providerSession : undefined
    )
  if (!providerSession) {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const launchConfig =
    (entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
    (sleeping?.agent === 'codex' ? sleeping.launchConfig : undefined)
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
        : resolveTuiAgentLaunchArgs('codex', state.settings, resumeTarget),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv('codex', state.settings),
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
