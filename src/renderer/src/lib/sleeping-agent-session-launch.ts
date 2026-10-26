import { useAppStore } from '@/store'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import {
  resolveSshHostReportedPlatform,
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { dropRecordedAgentPermissionArgs } from '../../../shared/tui-agent-permission-lift'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

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
  return resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId: repo?.connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    remotePlatform: resolveSshHostReportedPlatform(
      state,
      executionHostId,
      runtimeEnvironmentIdUnlessTwin(state, worktreeId)
    )
  })
}

// Mobile wake runs on the desktop host renderer; create recovery tabs without stealing desktop navigation.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const recorded =
    launchConfig && record.agent === 'codex'
      ? (() => {
          const target = getResumeLaunchTarget(record.worktreeId)
          return dropRecordedAgentPermissionArgs(
            record.agent,
            launchConfig,
            resolveStartupShell(target.platform, target.shell)
          )
        })()
      : launchConfig
  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: record.agent,
    pendingStartup: {
      resume: {
        recipe: {
          source: 'saved',
          ...(record.launchConfig ? { launchConfig: record.launchConfig } : {})
        }
      },
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
      ...(recorded ? { agentArgsOverride: recorded.agentArgs ?? '' } : {}),
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
