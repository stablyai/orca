import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session-resume'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindBuildColdRestoreAgentResumeStartup(session: ConnectPanePtySession): void {
  session.buildColdRestoreAgentResumeStartup = (): ColdRestoreAgentResumeStartup | null => {
    if (session.pendingStartupCommand) {
      return null
    }
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    const sleepingRecordEntry = session.getSleepingRecordForPane(state)
    const sleepingRecord = sleepingRecordEntry?.record
    if (session.isLegacyWorkerAutomaticResumeBlocked()) {
      return null
    }
    const useLiveEntry = entry && entry.state !== 'done'
    const agent = useLiveEntry ? entry.agentType : sleepingRecord?.agent
    if (!agent || !isResumableTuiAgent(agent)) {
      return null
    }
    const providerSession = normalizeAgentProviderSession(
      useLiveEntry ? entry.providerSession : sleepingRecord?.providerSession
    )
    if (!providerSession) {
      return null
    }
    const matchingSleepingLaunchConfig =
      sleepingRecord?.launchConfig &&
      (!useLiveEntry ||
        (sleepingRecord.agent === agent &&
          agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
        ? sleepingRecord.launchConfig
        : undefined
    const liveLaunchConfig =
      useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined
    const legacyLaunchConfig = liveLaunchConfig ?? matchingSleepingLaunchConfig
    const legacyRecordedConnectionId = liveLaunchConfig
      ? (session.connectionId ?? null)
      : (sleepingRecord?.connectionId ?? null)
    return {
      agent,
      agentLaunch: {
        resume: {
          operation: 'resume',
          sessionKey: {
            worktreeId: session.deps.worktreeId,
            baseAgent: agent,
            providerSessionId: providerSession.id
          }
        }
      },
      resumeProviderSession: providerSession,
      command: '',
      env: session.paneIdentityEnv,
      ...(legacyLaunchConfig
        ? {
            launchConfig: legacyLaunchConfig,
            legacyResumeRecordedConnectionId: legacyRecordedConnectionId
          }
        : {}),
      useLiveEntry: Boolean(useLiveEntry),
      hasSleepingRecord: Boolean(sleepingRecord),
      sleepingRecordEntry
    }
  }
}
