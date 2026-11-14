import { agentSessionExecutionPolicySchema } from '../agent-session-execution-policy'
import { agentSessionAdvisoryPolicySchema } from '../agent-session-advisory-policy'

export const AGENT_SESSION_RECORD_SCHEMA_VERSION = 2 as const
// Older writers must set constrained rows aside rather than resume them without their policy.
export const AGENT_SESSION_ADVISORY_RECORD_SCHEMA_VERSION = 3 as const
export const AGENT_SESSION_EXECUTION_RECORD_SCHEMA_VERSION = 4 as const

export function isAgentSessionPolicyRecord(record: Record<string, unknown>): boolean {
  return (
    (record.schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION &&
      !Object.hasOwn(record, 'advisoryPolicy') &&
      !Object.hasOwn(record, 'executionPolicy')) ||
    (record.schemaVersion === AGENT_SESSION_ADVISORY_RECORD_SCHEMA_VERSION &&
      !Object.hasOwn(record, 'executionPolicy') &&
      agentSessionAdvisoryPolicySchema.safeParse(record.advisoryPolicy).success) ||
    (record.schemaVersion === AGENT_SESSION_EXECUTION_RECORD_SCHEMA_VERSION &&
      record.provider === 'codex' &&
      !Object.hasOwn(record, 'advisoryPolicy') &&
      agentSessionExecutionPolicySchema.safeParse(record.executionPolicy).success)
  )
}
