import type { AgentSessionExecutionQualification } from '../../agent-session/agent-session-execution-qualification'
import type { AgentSessionOptionsResult } from '../../agent-session/options/agent-session-options-result'
import type { AgentSessionAdvisoryPolicy } from '../../agent-session/agent-session-advisory-policy'
import type { AgentSessionExecutionEvidence } from '../../agent-session/agent-session-execution-evidence'
import type { AgentSessionAdvisoryReceipt } from '../../agent-session/agent-session-advisory-receipt'

/** Option facts retain their input/default/confirmation labels; this is no execution attestation. */
export type OrchestrationWorkerSettings =
  | {
      kind: 'options'
      sessionId: string
      runtimeFence: number
      agent: string
      execution?: AgentSessionExecutionEvidence
      advisory?: Pick<
        AgentSessionAdvisoryPolicy,
        'sourcePin' | 'dataScope' | 'deadlineAt' | 'maxModelCalls'
      > & {
        policyFingerprint: string
        qualification: 'unqualified'
      }
      current: AgentSessionOptionsResult['current']
    }
  | {
      kind: 'execution-receipt'
      sessionId: string
      runtimeFence: number
      agent: 'codex'
      qualification: AgentSessionExecutionQualification
    }
  | {
      kind: 'advisory-receipt'
      sessionId: string
      runtimeFence: number
      agent: 'claude'
      qualification: {
        runtime: NonNullable<AgentSessionAdvisoryReceipt['runtime']>
        policy: Pick<
          Extract<AgentSessionAdvisoryPolicy, { schema: 2 }>,
          'schema' | 'sourcePin' | 'dataScope' | 'deadlineAt' | 'maxModelCalls' | 'binding'
        >
        receipt: Omit<AgentSessionAdvisoryReceipt, 'spawnTokenHash'>
        metadata: AgentSessionExecutionQualification['metadata']
      }
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
