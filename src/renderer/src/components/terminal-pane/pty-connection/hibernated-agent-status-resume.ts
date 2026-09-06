import type { AppState } from '@/store'
import { isPassiveCompletedHibernationEvidence } from '@/lib/sleeping-agent-pane-ownership'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session-resume'
import { pickParsedAgentStatusPayload } from '../../../../../shared/agent-status-types'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

type HibernatedAgentStatusResumeState = Pick<
  AppState,
  | 'dismissRetainedAgent'
  | 'registerAgentLaunchConfig'
  | 'retainedAgentsByPaneKey'
  | 'setAgentStatus'
>

export function restoreCompletedAgentStatusAfterColdResume(args: {
  leafId: string
  paneKey: string
  tabId: string
  state: HibernatedAgentStatusResumeState
  startup: ColdRestoreAgentResumeStartup | null
}): boolean {
  const startup = args.startup
  const sleeping = startup?.sleepingRecordEntry
  if (
    !startup ||
    !sleeping ||
    startup.useLiveEntry ||
    startup.agent !== sleeping.record.agent ||
    !agentProviderSessionsEqual(
      sleeping.record.agent,
      startup.resumeProviderSession,
      sleeping.record.providerSession
    ) ||
    !isPassiveCompletedHibernationEvidence(sleeping.record)
  ) {
    return false
  }
  const retained = args.state.retainedAgentsByPaneKey[sleeping.paneKey]
  const entry = retained?.entry
  if (
    !entry ||
    entry.state !== 'done' ||
    entry.interrupted === true ||
    retained.worktreeId !== sleeping.record.worktreeId ||
    entry.agentType !== sleeping.record.agent ||
    !entry.providerSession ||
    !agentProviderSessionsEqual(
      sleeping.record.agent,
      entry.providerSession,
      sleeping.record.providerSession
    )
  ) {
    return false
  }

  args.state.registerAgentLaunchConfig(args.paneKey, startup.launchConfig, {
    agentType: sleeping.record.agent,
    launchToken: startup.launchToken,
    tabId: args.tabId,
    leafId: args.leafId,
    providerSession: sleeping.record.providerSession
  })
  args.state.setAgentStatus(
    args.paneKey,
    {
      ...pickParsedAgentStatusPayload(entry),
      ...(entry.orchestration ? { orchestration: entry.orchestration } : {}),
      ...(entry.promptInteractionKey ? { promptInteractionKey: entry.promptInteractionKey } : {})
    },
    entry.terminalTitle ?? sleeping.record.terminalTitle,
    { stateStartedAt: entry.stateStartedAt },
    {
      tabId: args.tabId,
      worktreeId: sleeping.record.worktreeId,
      ...(sleeping.record.connectionId !== undefined
        ? { connectionId: sleeping.record.connectionId }
        : {})
    },
    {
      providerSession: sleeping.record.providerSession,
      launchToken: startup.launchToken
    }
  )
  if (sleeping.paneKey !== args.paneKey) {
    args.state.dismissRetainedAgent(sleeping.paneKey)
  }
  return true
}
