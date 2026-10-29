import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
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
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}
