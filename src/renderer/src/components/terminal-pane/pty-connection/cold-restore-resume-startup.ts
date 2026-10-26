import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  agentResumeOriginNamesAnotherExecutionHost,
  sleepingRecordNamesAnotherExecutionHost
} from '@/lib/sleeping-record-execution-host-scope'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session-resume'

import type { HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export const NOT_REOPENED: HeldPaneReopenOutcome = { reopened: false, agentResumed: false }

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
    const matchingSleepingLaunchConfig =
      sleepingRecord?.launchConfig &&
      (!useLiveEntry ||
        (sleepingRecord.agent === agent &&
          agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
        ? sleepingRecord.launchConfig
        : undefined
    const launchConfig =
      (useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
      matchingSleepingLaunchConfig
    const coldRestoreLaunchToken = createBrowserUuid()
    return {
      agent,
      resume: { recipe: { source: 'saved', ...(launchConfig ? { launchConfig } : {}) } },
      env: { ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken },
      resumeProviderSession: providerSession,
      resumeOrigin: 'saved',
      resumeSource: {
        cancelled: false,
        ...(sleepingRecord &&
        sleepingRecord.agent === agent &&
        agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)
          ? { record: sleepingRecord }
          : {}),
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
