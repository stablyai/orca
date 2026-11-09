import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState
} from '@/lib/workspace/ownership/connection-owner-resolution'
import { normalizeExecutionHostId } from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import {
  INTERRUPTED_TURN_CONTINUE_PROMPT,
  buildAgentResumeStartupPlan
} from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
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
import { resolveResumeLaunchRecipe } from '../../../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { HeldPaneReopenOutcome } from '../../session-restore/newer-daemon/newer-daemon-hold-state'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export const NOT_REOPENED: HeldPaneReopenOutcome = { reopened: false, agentResumed: false }

/** Interrupted turns already continued, so a retried cold restore never sends `continue` twice. */
const continuedInterruptedTurns = new Set<string>()

/** Identity of the turn an agent was in when its host went away. */
export function interruptedTurnKey(
  entry: { updatedAt: number; stateStartedAt?: number },
  paneKey: string
): string {
  return `${paneKey}\u0000${entry.stateStartedAt ?? entry.updatedAt}`
}

/** Called when a resume that carries `continue` actually launches (startups are often built and
 *  discarded, e.g. on every reattach check). */
export function markInterruptedTurnContinued(key: string | undefined): void {
  if (key) {
    continuedInterruptedTurns.add(key)
  }
}

/**
 * A cold-restored agent on a remote host whose last status was working lost its turn when the host
 * restarted (reboot, crash, rollover): carry it on. Only with fresh evidence (a recent working
 * status), never after a deliberate sleep (that leaves a sleeping record), once per interrupted turn.
 * Local panes are left alone: their PTYs outlive app restarts.
 */
export function shouldContinueInterruptedTurn(
  entry: { state: string; updatedAt: number; stateStartedAt?: number } | null | undefined,
  runtimeEnvironmentId: string | null,
  context: { paneKey: string; hasSleepingRecord: boolean; now?: number }
): boolean {
  if (!runtimeEnvironmentId || context.hasSleepingRecord || entry?.state !== 'working') {
    return false
  }
  if ((context.now ?? Date.now()) - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return false
  }
  return !continuedInterruptedTurns.has(interruptedTurnKey(entry, context.paneKey))
}

type AppState = ReturnType<typeof useAppStore.getState>

/** The agent session a cold restore of this pane would resume; read-only, so pre-spawn checks can share it. */
export function findColdRestoreResumeSource(session: ConnectPanePtySession, state: AppState) {
  const entry = state.agentStatusByPaneKey[session.cacheKey]
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
    const launchConfig =
      (useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
      matchingSleepingRecord?.launchConfig
    // Quote resume for the live pane’s effective Windows shell rather than the platform’s PowerShell default.
    // Why: a nested-SSH pane on a server runs on its SSH target; the pane's host names a worktree
    // copy, while a folder's own record carries its connection.
    const paneHostId = normalizeExecutionHostId(session.executionHostId)
    const connectionId =
      (paneHostId && parseWorkspaceKey(session.deps.worktreeId)?.type !== 'folder'
        ? getConnectionIdForWorktreeCopy(state, session.deps.worktreeId, paneHostId)
        : getConnectionIdFromState(state, session.deps.worktreeId)) ?? null
    const resumeTarget = resolveAgentResumeLaunchTarget({
      projectRuntime: session.projectRuntime,
      connectionId,
      executionHostId: session.executionHostId,
      worktreePath: session.worktree?.path,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: session.shellOverride,
      // Why the transport's runtime: the pane's own connection names the SSH target's owner.
      remotePlatform: resolveSshHostReportedPlatform(
        state,
        session.executionHostId,
        session.transport.getRuntimeEnvironmentId?.() ?? null,
        connectionId
      ),
      runtimeHostPlatform: resolveRuntimeHostReportedPlatform(state, session.executionHostId),
      runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(
        state,
        session.executionHostId
      )
    })
    const continueTurn =
      entry !== null &&
      shouldContinueInterruptedTurn(entry, session.transport.getRuntimeEnvironmentId?.() ?? null, {
        paneKey: session.cacheKey,
        hasSleepingRecord: Boolean(sleepingRecord)
      })
    const startupPlan = buildAgentResumeStartupPlan({
      agent,
      providerSession,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      ...resolveResumeLaunchRecipe(launchConfig),
      platform: resumeTarget.platform,
      agentHostPlatform: resumeTarget.agentHostPlatform,
      shell: resumeTarget.shell,
      launchCwd: session.worktree?.path,
      // A remote host that restarted under a working agent (reboot, crash, VM rollover) killed it
      // mid-turn; its last status still says working. Carry the turn on instead of waiting.
      continuePrompt: continueTurn ? INTERRUPTED_TURN_CONTINUE_PROMPT : null
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
      ...(continueTurn && entry
        ? { interruptedTurnKey: interruptedTurnKey(entry, session.cacheKey) }
        : {}),
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
