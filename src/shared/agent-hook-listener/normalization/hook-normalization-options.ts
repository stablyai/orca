import type { AgentMainAgentStatus } from '../../agent-status/lifecycle/main-agent-status'
import type { AgentHookEventPayload } from '../listener-event'

export type HookNormalizationOptions = {
  deferCompactOwnershipToClient?: boolean
  previousOpenCodeMainAgent?: AgentMainAgentStatus
  bindingStatusByPaneKey?: ReadonlyMap<string, AgentHookEventPayload>
  /** Spool replay restates recorded evidence; it never advances turn identity. */
  isReplay?: boolean
  replayReceivedAt?: number
  admitOpenCodeTui?: (
    identity: Pick<
      AgentHookEventPayload,
      'paneKey' | 'launchToken' | 'hookEventName' | 'hasExplicitPrompt'
    >
  ) => boolean | 'preserve-poster'
}
