import type { PtyPaneStartup } from './pty-pane-startup'
import { useAppStore } from '@/store/index'
import { recordPaneWakeThroughLayoutOwner } from '@/store/terminals/terminal-sleep-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  isResumableTuiAgent,
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'
import {
  mailWakeObligation,
  undispatchedMailWakeRecord
} from '../../../../../../shared/agent-session/lifecycle/mail-wake-obligation'

export function isColdRestoreStartup(
  startup: PendingStartupCommand | PtyPaneStartup | undefined
): startup is ColdRestoreAgentResumeStartup {
  return Boolean(
    startup &&
    'agent' in startup &&
    'resumeProviderSession' in startup &&
    'useLiveEntry' in startup &&
    'sleepingRecordEntry' in startup
  )
}

/** Keeps an existing pane resumable until the agent reports its identity again. */
export function paneResumeRecord(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): SleepingAgentSessionRecord | null {
  const coldRestore = isColdRestoreStartup(startupOverride) ? startupOverride : null
  const agent = coldRestore?.agent ?? session.paneStartup?.launchAgent
  const providerSession =
    coldRestore?.resumeProviderSession ?? session.paneStartup?.resumeProviderSession
  if (!agent || !isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  const launchConfig = coldRestore?.launchConfig ?? session.paneStartup?.launchConfig
  const now = Date.now()
  const mailWake = coldRestore?.sleepingRecordEntry?.record.mailWake
  return {
    paneKey: session.cacheKey,
    tabId: session.deps.tabId,
    worktreeId: session.deps.worktreeId,
    agent,
    providerSession,
    ...(coldRestore?.connectionId !== undefined ? { connectionId: coldRestore.connectionId } : {}),
    prompt: '',
    state: 'done',
    capturedAt: now,
    updatedAt: now,
    ...(launchConfig ? { launchConfig } : {}),
    // Quit origin preserves unfinished existing-pane records during sweeps; completed live bookmarks are passive history.
    ...(mailWake
      ? {
          mailWake: {
            ...mailWake,
            ...(session.transport.getPtyId() &&
            session.remotePtyIncarnationId &&
            coldRestore?.launchToken
              ? {
                  attempt: {
                    ptyId: session.transport.getPtyId()!,
                    incarnationId: session.remotePtyIncarnationId,
                    launchToken: coldRestore?.launchToken,
                    startedAt: mailWake.startedAt
                  }
                }
              : {})
          }
        }
      : {}),
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
}

export function currentMailWakeStartup(
  startup: ColdRestoreAgentResumeStartup,
  records: Readonly<Record<string, SleepingAgentSessionRecord>>
): ColdRestoreAgentResumeStartup {
  const original = startup.sleepingRecordEntry
  const current = original && records[original.paneKey]
  return original &&
    mailWakeObligation(current) === 'retained' &&
    current?.mailWake &&
    current.agent === startup.agent &&
    current.worktreeId === original.record.worktreeId &&
    (current.connectionId ?? null) === (original.record.connectionId ?? null) &&
    current.mailWake.capturedAt ===
      (original.record.mailWake?.capturedAt ?? original.record.capturedAt) &&
    agentProviderSessionsEqual(
      current.agent,
      current.providerSession,
      startup.resumeProviderSession
    )
    ? { ...startup, sleepingRecordEntry: { ...original, record: current } }
    : startup
}

export function installPaneResumeRecord(session: ConnectPanePtySession): void {
  session.keepResumeRecordAfterColdRestoreSpawn = (
    startup: ColdRestoreAgentResumeStartup | null
  ): void => {
    if (!startup || startup.resumeSource?.cancelled) {
      return
    }
    const state = useAppStore.getState()
    startup = currentMailWakeStartup(startup, state.sleepingAgentSessionsByPaneKey)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      if (!startup.useLiveEntry && startup.sleepingRecordEntry) {
        const retained = paneResumeRecord(session, startup)
        if (retained?.mailWake) {
          state.rememberSleepingAgentSession(retained, startup.sleepingRecordEntry.record)
        } else {
          recordPaneWakeThroughLayoutOwner(state, session.deps.worktreeId, session.cacheKey)
        }
        session.clearSleepingRecordProviderDuplicates(
          state,
          startup.sleepingRecordEntry,
          session.cacheKey
        )
      }
      return
    }
    const captured = startup.sleepingRecordEntry
    if (captured && state.sleepingAgentSessionsByPaneKey[captured.paneKey] !== captured.record) {
      return
    }
    if (!captured && startup.useLiveEntry) {
      const expected = startup.resumeSource?.expectedStatus
      const current = state.agentStatusByPaneKey[session.cacheKey]
      if (
        !expected ||
        current?.updatedAt !== expected.receivedAt ||
        current.stateStartedAt !== expected.stateStartedAt
      ) {
        return
      }
    }
    // Spawn proves a PTY exists, not that the agent has replaced its resume identity.
    const record = paneResumeRecord(session, startup)
    if (record) {
      state.rememberSleepingAgentSession(
        record,
        captured && captured.paneKey === session.cacheKey ? captured.record : undefined
      )
    }
    if (!startup.useLiveEntry && startup.sleepingRecordEntry) {
      session.clearSleepingRecordProviderDuplicates(
        useAppStore.getState(),
        startup.sleepingRecordEntry,
        session.cacheKey
      )
    }
  }
}

/** Called only after a definite refusal before dispatch, never after a lost spawn reply. */
export function restoreUndispatchedMailWake(record: SleepingAgentSessionRecord): void {
  const state = useAppStore.getState()
  const next = undispatchedMailWakeRecord(record)
  if (next && state.sleepingAgentSessionsByPaneKey[record.paneKey] === record) {
    state.rememberSleepingAgentSession(next, record)
  }
}
