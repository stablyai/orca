import type { AgentSessionHandoffStage } from './agent-session-record'

/** Released clients still read owner under the old handoffStatus name; parse as unknown because older hosts sent additional fields. */
export type AgentSessionHandoffStatus = {
  owner: 'native' | 'none'
  direction: 'to-native' | null
  phase: 'idle' | 'switching' | 'failed'
  stage: AgentSessionHandoffStage | null
  operationId: string | null
  error?: { message: string; recoverableOwner: 'none' }
}
