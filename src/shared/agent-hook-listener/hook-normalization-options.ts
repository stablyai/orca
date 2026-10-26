import type { AgentMainAgentStatus } from '../agent-status-types'
import type { AgentHookEventPayload } from './listener-event'

export type HookNormalizationOptions = {
  deferCompactOwnershipToClient?: boolean
  previousOpenCodeMainAgent?: AgentMainAgentStatus
  admitOpenCodeTui?: (
    identity: Pick<
      AgentHookEventPayload,
      'paneKey' | 'launchToken' | 'hookEventName' | 'hasExplicitPrompt'
    >
  ) => boolean | 'preserve-poster'
}
