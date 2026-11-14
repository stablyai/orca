import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { buildAgentResumeStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import '@/diagnostics/telemetry/telemetry'
import { tuiAgentToAgentKind } from '../../../../../shared/agent-kind'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
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
import { translate } from '@/i18n/i18n'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

export type ResumeSleepingAgentSessionsOptions = {
  suppressNavigation?: boolean
  // Mounted in-place wakes own these claim keys until spawn succeeds; generic resume must neither launch nor clear their records.
  skipClaimKeys?: ReadonlySet<string>
  /** Called with the tab id of each freshly launched resume tab, so
   *  navigation-suppressed callers can background-mount exactly those tabs. */
  onSessionLaunched?: (tabId: string) => void
}

function getResumeLaunchTarget(worktreeId: string): AgentResumeLaunchTarget {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  // The resume tab is created without a shell override, so the global Windows shell wins.
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  // Why: a folder or nested-SSH workspace on a server runs on its SSH target, not the server.
  const connectionId = repo?.connectionId ?? getConnectionIdFromState(state, worktreeId)
  return resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      executionHostId,
      runtimeEnvironmentIdUnlessTwin(state, worktreeId),
      connectionId
    ),
    runtimeHostPlatform: resolveRuntimeHostReportedPlatform(state, executionHostId),
    runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(state, executionHostId)
  })
}

// Mobile wake runs on the desktop host renderer; create recovery tabs without stealing desktop navigation.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const resumeTarget = getResumeLaunchTarget(record.worktreeId)
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    ...resolveResumeLaunchRecipe(launchConfig, record.agent, record.providerSession),
    platform: resumeTarget.platform,
    agentHostPlatform: resumeTarget.agentHostPlatform,
    shell: resumeTarget.shell,
    launchCwd: state.getKnownWorktreeById(record.worktreeId)?.path
  })
  if (!startupPlan) {
    toast.error(
      translate(
        'auto.lib.resume.sleeping.agent.session.f235f604fd',
        'This agent session cannot be resumed.'
      )
    )
    return false
  }

  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: record.agent,
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: record.providerSession,
      resumeOrigin: 'saved',
      resumeSource: {
        cancelled: false,
        record,
        ...(state.agentStatusByPaneKey[record.paneKey]
          ? {
              expectedStatus: {
                paneKey: record.paneKey,
                receivedAt: state.agentStatusByPaneKey[record.paneKey].updatedAt,
                stateStartedAt: state.agentStatusByPaneKey[record.paneKey].stateStartedAt
              }
            }
          : {})
      },
      launchAgent: record.agent,
      ...(launchConfig ? { agentArgsOverride: startupPlan.launchConfig.agentArgs } : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      showSessionRestoredBanner: true,
      telemetry: {
        agent_kind: tuiAgentToAgentKind(record.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    },
    automaticResumeClaim: {
      worktreeId: record.worktreeId,
      launchAgent: record.agent,
      providerSession: record.providerSession
    },
    ...(options?.suppressNavigation ? { activate: false, recordInteraction: false } : {})
  })
  state.clearSleepingAgentSession(record.paneKey)
  if (!options?.suppressNavigation) {
    state.setActiveTabType('terminal', record.worktreeId)
  }
  persistAgentLaunchTabOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
