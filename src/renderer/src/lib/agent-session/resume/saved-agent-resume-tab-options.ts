import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { buildAgentResumeStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { tuiAgentToAgentKind } from '../../../../../shared/agent-status/identity/agent-kind'
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
import { resolveResumeLaunchRecipe } from '../../../../../shared/agent-launch/choices/resume-launch-recipe'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AppState } from '@/store/types'

function getResumeLaunchTarget(
  state: AppState,
  worktreeId: string,
  startupCwd: string | undefined,
  shellOverride: string | undefined
): AgentResumeLaunchTarget & { launchCwd: string | undefined; isRemote: boolean } {
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  // Why: a folder or nested-SSH workspace on a server runs on its SSH target, not the server.
  const connectionId = repo?.connectionId ?? getConnectionIdFromState(state, worktreeId)
  const launchCwd = startupCwd ?? worktree?.path
  const statuses = state.runtimeStatusByEnvironmentId
  return {
    ...resolveAgentResumeLaunchTarget({
      projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
      connectionId,
      executionHostId,
      worktreePath: launchCwd,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: shellOverride,
      remotePlatform: resolveSshHostReportedPlatform(
        state,
        executionHostId,
        runtimeEnvironmentIdUnlessTwin(state, worktreeId),
        connectionId
      ),
      runtimeHostPlatform: resolveRuntimeHostReportedPlatform(statuses, executionHostId),
      runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(
        statuses,
        executionHostId
      )
    }),
    launchCwd,
    isRemote: Boolean(connectionId)
  }
}

export function buildSavedAgentResumeTabOptions(
  state: AppState,
  worktreeId: string,
  record: Pick<SleepingAgentSessionRecord, 'agent' | 'providerSession' | 'launchConfig'>,
  options: { launchSource: 'sidebar' | 'shortcut'; startupCwd?: string; shellOverride?: string }
) {
  const { agent, providerSession, launchConfig } = record
  const resumeTarget = getResumeLaunchTarget(
    state,
    worktreeId,
    options.startupCwd,
    options.shellOverride
  )
  const startupPlan = buildAgentResumeStartupPlan({
    agent,
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    ...resolveResumeLaunchRecipe(launchConfig, agent, providerSession),
    ...resumeTarget
  })
  if (!startupPlan) {
    return null
  }
  return {
    launchAgent: agent,
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: providerSession,
      resumeOrigin: 'saved' as const,
      launchAgent: agent,
      ...(launchConfig ? { agentArgsOverride: startupPlan.launchConfig.agentArgs } : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      showSessionRestoredBanner: true,
      telemetry: {
        agent_kind: tuiAgentToAgentKind(agent),
        launch_source: options.launchSource,
        request_kind: 'resume' as const
      }
    },
    automaticResumeClaim: {
      worktreeId,
      launchAgent: agent,
      providerSession
    }
  }
}
