import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveAgentResumeLaunchTarget,
  resolveSshHostReportedPlatform
} from '@/lib/agent-resume-launch-target'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import { claudeConfigDirFromTranscriptPath } from '../../../shared/claude-transcript-config-dir'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'

/** A fresh process for the same provider session. Null means do not spawn. */
export type AgentSessionRestartStartup = {
  command: string
  startupCommandDelivery: 'shell-ready'
  launchAgent: ResumableTuiAgent
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession: AgentProviderSessionMetadata
  /** Do not move this process onto the account currently selected in Settings. */
  resumeOnSelectedAccount: false
}

export type AgentSessionRestartStartupPane = {
  tabId: string
  leafId: string
  worktreeId: string
  shellOverride?: string
}

/**
 * Builds the exact resume command for a live pane.
 * Unlike account restart, a missing session or a WSL Codex pane returns null.
 * Unrecorded launches do not pick up settings permission defaults.
 */
export function buildAgentSessionRestartStartup(
  agent: TuiAgent,
  args: AgentSessionRestartStartupPane
): AgentSessionRestartStartup | null {
  if (!isResumableTuiAgent(agent)) {
    return null
  }
  const state = useAppStore.getState()
  // A missing row is not local. Account restart may assume local; this feature must not.
  const executionHostId = getKnownExecutionHostIdForWorktree(state, args.worktreeId)
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const entry = state.agentStatusByPaneKey[makePaneKey(args.tabId, args.leafId)]
  if (entry?.agentType !== agent) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(entry.providerSession)
  if (!providerSession) {
    return null
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  if (
    agent === 'codex' &&
    projectRuntime?.status === 'resolved' &&
    projectRuntime.runtime.kind === 'wsl'
  ) {
    return null
  }
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = worktree ? state.repos.find((item) => item.id === worktree.repoId) : null
  const launchConfig = state.getAgentLaunchConfigForStatusEntry(entry)
  // Current settings overrides can embed permission or account flags that were not on this launch.
  if (!launchConfig) {
    return null
  }
  // A missing Claude home is not the default account: the original launch can inject
  // its profile without storing CLAUDE_CONFIG_DIR. Prove it from the transcript or skip.
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
    cmdOverrides: {},
    // Recorded argv and env only. Settings defaults and live overrides would add flags the launch never had.
    agentArgs: launchConfig.agentArgs,
    agentEnv: launchConfig.agentEnv,
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell,
    launchCwd:
      state.tabsByWorktree[args.worktreeId]?.find((tab) => tab.id === args.tabId)?.startupCwd ??
      worktree?.path
  })
  if (!startupPlan) {
    return null
  }
  const env = startupPlan.env ? { ...startupPlan.env } : undefined
  // Main pins the transcript's home; it alone knows whether that home is the default one.
  if (
    agent === 'claude' &&
    !env?.CLAUDE_CONFIG_DIR?.trim() &&
    !claudeConfigDirFromTranscriptPath(providerSession.transcriptPath, providerSession.id)
  ) {
    return null
  }
  return {
    startupCommandDelivery: 'shell-ready',
    launchAgent: agent,
    command: startupPlan.launchCommand,
    ...(env ? { env } : {}),
    launchConfig: startupPlan.launchConfig,
    resumeProviderSession: providerSession,
    resumeOnSelectedAccount: false
  }
}
