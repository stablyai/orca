import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import '@/diagnostics/telemetry/telemetry'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { translate } from '@/i18n/i18n'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { buildSavedAgentResumeTabOptions } from './saved-agent-resume-tab-options'

export type ResumeSleepingAgentSessionsOptions = {
  suppressNavigation?: boolean
  // Mounted in-place wakes own these claim keys until spawn succeeds; generic resume must neither launch nor clear their records.
  skipClaimKeys?: ReadonlySet<string>
  /** Called with the tab id of each freshly launched resume tab, so
   *  navigation-suppressed callers can background-mount exactly those tabs. */
  onSessionLaunched?: (tabId: string) => void
}

// Mobile wake runs on the desktop host renderer; create recovery tabs without stealing desktop navigation.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  const resume = buildSavedAgentResumeTabOptions(state, record.worktreeId, record, {
    launchSource: 'sidebar'
  })
  if (!resume) {
    toast.error(
      translate(
        'auto.lib.resume.sleeping.agent.session.f235f604fd',
        'This agent session cannot be resumed.'
      )
    )
    return false
  }
  const expectedStatus = state.agentStatusByPaneKey.get(record.paneKey)
  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    ...resume,
    pendingStartup: {
      ...resume.pendingStartup,
      resumeSource: {
        cancelled: false,
        record,
        ...(expectedStatus
          ? {
              expectedStatus: {
                paneKey: record.paneKey,
                receivedAt: expectedStatus.updatedAt,
                stateStartedAt: expectedStatus.stateStartedAt
              }
            }
          : {})
      }
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
