import type { AgentSessionHandoffStage } from './agent-session-record'

/** `agentSession.handoffStatus`. Named for the removed terminal handoff; released desktop clients
 *  still read `owner`. Clients parse the reply as unknown, since older hosts sent more fields. */
export type AgentSessionHandoffStatus = {
  owner: 'native' | 'none'
  direction: 'to-native' | null
  phase: 'idle' | 'switching' | 'failed'
  stage: AgentSessionHandoffStage | null
  operationId: string | null
  error?: { message: string; recoverableOwner: 'none' }
}
