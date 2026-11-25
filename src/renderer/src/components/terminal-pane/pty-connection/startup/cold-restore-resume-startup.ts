import {
  readManagedAgentCommandsForRepo,
  readManagedAgentCommandsForWorktree
} from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import {
  isWslShellName,
  resolveLocalWindowsTerminalShellOverrideForTab
} from '../../../../../../shared/shell/launch/local-windows-terminal-runtime'
import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { buildAgentResumeStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import {
  resolveRuntimeHostReportedPlatform,
  resolveRuntimeHostTerminalWindowsShell,
  resolveSshHostReportedPlatform,
  resolveAgentResumeLaunchTarget
} from '@/lib/agent-session/resume/agent-resume-launch-target'
import {
  agentResumeOriginNamesAnotherExecutionHost,
  sleepingRecordNamesAnotherExecutionHost
} from '@/lib/agent-session/resume/sleeping-record-execution-host-scope'
import { resolveResumeLaunchRecipe } from '../../../../../../shared/agent-launch/choices/resume-launch-recipe'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'

import type { HeldPaneReopenOutcome } from '../../session-restore/newer-daemon/newer-daemon-hold-state'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export const NOT_REOPENED: HeldPaneReopenOutcome = { reopened: false, agentResumed: false }

type AppState = ReturnType<typeof useAppStore.getState>

/** The agent session a cold restore of this pane would resume; read-only, so pre-spawn checks can share it. */
export function findColdRestoreResumeSource(session: ConnectPanePtySession, state: AppState) {
  const entry = state.agentStatusByPaneKey.get(session.cacheKey)
  const sleepingRecordEntry = session.getSleepingRecordForPane(state)
  const sleepingRecord = sleepingRecordEntry?.record
  const liveEntry = entry && entry.state !== 'done' ? entry : null
  const agent = liveEntry ? liveEntry.agentType : sleepingRecord?.agent
  if (!agent || !isResumableTuiAgent(agent)) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(
    liveEntry ? liveEntry.providerSession : sleepingRecord?.providerSession
  )
  return providerSession ? { agent, providerSession, liveEntry, sleepingRecordEntry } : null
}

export function bindBuildColdRestoreAgentResumeStartup(session: ConnectPanePtySession): void {
  session.buildColdRestoreAgentResumeStartup = (): ColdRestoreAgentResumeStartup | null => {
    if (session.pendingStartupCommand) {
      return null
    }
    const state = useAppStore.getState()
    const source = findColdRestoreResumeSource(session, state)
    if (!source) {
      return null
    }
    const { agent, providerSession, sleepingRecordEntry } = source
    const entry = source.liveEntry
    const sleepingRecord = sleepingRecordEntry?.record
    const useLiveEntry = entry !== null
    // Resume IDs name host-local transcripts: reject cross-host records, using catalog ownership while the pane transport is unresolved; retain the record for manual recovery.
    if (
      agentResumeOriginNamesAnotherExecutionHost(
        useLiveEntry ? entry.connectionId : sleepingRecord?.connectionId,
        session.executionHostId
      ) ||
      (sleepingRecord && sleepingRecordNamesAnotherExecutionHost(sleepingRecord, state))
    ) {
      return null
    }
    const matchingSleepingRecord =
      sleepingRecord?.agent === agent &&
      agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)
        ? sleepingRecord
        : undefined
    // A live invocation takes the decision's answer, none included; only otherwise the saved record.
    const launchConfig = entry
      ? state.getAgentLaunchConfigForStatusEntry(entry)
      : matchingSleepingRecord?.launchConfig
    // Quote resume for the live pane’s effective Windows shell rather than the platform’s PowerShell default.
    const paneHostId = normalizeExecutionHostId(session.executionHostId)
    const copyConnectionId = paneHostId
      ? getConnectionIdForWorktreeCopy(state, session.deps.worktreeId, paneHostId)
      : getConnectionIdFromState(state, session.deps.worktreeId)
    const connectionId =
      copyConnectionId === undefined ? (session.worktreeConnectionId ?? null) : copyConnectionId
    const runtimeHostTerminalWindowsShell = resolveRuntimeHostTerminalWindowsShell(
      readRuntimeStatuses(),
      paneHostId
    )
    const worktreePath = session.worktree?.path
    const resumeTarget = resolveAgentResumeLaunchTarget({
      projectRuntime: session.projectRuntime,
      connectionId,
      executionHostId: session.executionHostId,
      worktreePath,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: session.shellOverride,
      // Why the transport's runtime: the pane's own connection names the SSH target's owner.
      remotePlatform: resolveSshHostReportedPlatform(
        state,
        session.executionHostId,
        session.transport.getRuntimeEnvironmentId?.() ?? null,
        connectionId
      ),
      runtimeHostPlatform: resolveRuntimeHostReportedPlatform(
        readRuntimeStatuses(),
        session.executionHostId
      ),
      runtimeHostTerminalWindowsShell
    })
    const isWslWorktree = isWslUncPath(worktreePath ?? '')
    const isWslPane =
      isWslWorktree ||
      (resumeTarget.platform === 'win32' &&
        isWslShellName(
          paneHostId === LOCAL_EXECUTION_HOST_ID
            ? resolveLocalWindowsTerminalShellOverrideForTab({
                explicitShellOverride: session.shellOverride,
                defaultWindowsShell: state.settings?.terminalWindowsShell,
                isWslWorktree,
                projectRuntime: session.projectRuntime
              })
            : (runtimeHostTerminalWindowsShell ?? undefined)
        ))
    const managedAgentCommands =
      connectionId || isWslPane
        ? undefined
        : paneHostId
          ? readManagedAgentCommandsForRepo(
              { executionHostId: paneHostId, connectionId },
              resumeTarget.platform
            )
          : readManagedAgentCommandsForWorktree(state, session.deps.worktreeId)
    const startupPlan = buildAgentResumeStartupPlan({
      agent,
      providerSession,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      ...resolveResumeLaunchRecipe(launchConfig, agent, providerSession),
      platform: resumeTarget.platform,
      agentHostPlatform: resumeTarget.agentHostPlatform,
      shell: resumeTarget.shell,
      launchCwd: worktreePath,
      managedAgentCommands
    })
    if (!startupPlan) {
      return null
    }
    const coldRestoreLaunchToken = createBrowserUuid()
    return {
      agent,
      command: startupPlan.launchCommand,
      env: {
        ...startupPlan.env,
        ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken
      },
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: providerSession,
      connectionId:
        entry?.connectionId !== undefined
          ? entry.connectionId
          : matchingSleepingRecord?.connectionId,
      resumeOrigin: 'saved',
      resumeSource: {
        cancelled: false,
        ...(matchingSleepingRecord ? { record: matchingSleepingRecord } : {}),
        ...(useLiveEntry && entry
          ? {
              expectedStatus: {
                paneKey: session.cacheKey,
                receivedAt: entry.updatedAt,
                stateStartedAt: entry.stateStartedAt
              }
            }
          : {})
      },
      launchToken: coldRestoreLaunchToken,
      useLiveEntry: Boolean(useLiveEntry),
      hasSleepingRecord: Boolean(sleepingRecord),
      sleepingRecordEntry
    }
  }
}

/** Keeps the reattach fallback's actual fresh-agent outcome with the pane's start. */
export function reopenPaneAfterMissingReattach(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null,
  resumedAgent: (ptyId: string) => boolean
): Promise<HeldPaneReopenOutcome> {
  let resumeUnavailable = false
  return session
    .startFreshColdRestoreAgentResume(startup, {
      forceBlankRestoredViewport: true,
      onAgentResumeUnavailable: () => {
        resumeUnavailable = true
      }
    })
    .then(
      (ptyId: string | null) => ({
        reopened: ptyId !== null,
        agentResumed: ptyId !== null && resumedAgent(ptyId) && !resumeUnavailable
      }),
      () => NOT_REOPENED
    )
}
