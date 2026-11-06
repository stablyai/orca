import type {
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type StructuredAgentSessionOptionsArgs = {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  isVisible: boolean
  providerVisible: boolean
  providerStarting?: boolean
  providerRunning?: boolean
  hostOptionStamp?: string
  fence: number | null
  turnId: string | null
  /** The chat has a turn or a send: its value picks keep the remembered new-chat model. */
  hasTurn?: boolean
  unloadedTurnRevisions: number | undefined
  capturePresentation?: CaptureStructuredAgentSessionPresentation
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}

import type { AgentSessionConversationCommand } from '../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'

export type StructuredSessionConversationSupport = {
  sessionId: string
  commands: readonly AgentSessionConversationCommand[]
  threadGoal: AgentSessionOptionsResult['threadGoal']
  reportedThreadGoal: AgentSessionOptionsResult['reportedThreadGoal']
  contextUsage: AgentSessionOptionsResult['contextUsage']
  acceptsImages: boolean | undefined
  rewind: AgentSessionRewindSupport
  /** Whether the installed agent copies its conversation natively; absent means unknown. */
  forkSupport?: AgentSessionOptionsResult['forkSupport']
  /** The fence the read answered for; rewind support is only that runtime's. */
  fence: number | null
}
