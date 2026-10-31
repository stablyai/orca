import type {
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { AgentType } from '../../../../shared/agent-status-types'
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
  unloadedTurnRevisions: number | undefined
  capturePresentation?: CaptureStructuredAgentSessionPresentation
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}

import type { AgentSessionConversationCommand } from '../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'

export type StructuredSessionConversationSupport = {
  sessionId: string
  commands: readonly AgentSessionConversationCommand[]
  threadGoal: AgentSessionOptionsResult['threadGoal']
  reportedThreadGoal: AgentSessionOptionsResult['reportedThreadGoal']
  contextUsage: AgentSessionOptionsResult['contextUsage']
  acceptsImages: boolean | undefined
  rewind: AgentSessionRewindSupport
  /** The fence the read answered for; rewind support is only that runtime's. */
  fence: number | null
}
