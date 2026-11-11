import type { AgentSessionOptionsResult } from '../../agent-session/options/agent-session-options-result'

/** Option facts retain their input/default/confirmation labels; this is no execution attestation. */
export type OrchestrationWorkerSettings =
  | {
      kind: 'options'
      sessionId: string
      runtimeFence: number
      agent: string
      current: AgentSessionOptionsResult['current']
    }
  | {
      kind: 'unknown'
      reason:
        | 'terminal_worker'
        | 'not_live'
        | 'not_held'
        | 'host_unavailable'
        | 'identity_changed'
        | 'read_failed'
        | 'remote_worker'
    }
