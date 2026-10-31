import type { AgentSessionRecord } from './agent-session-record'

/** A default pick is separate from explicit overrides; messages still capture concrete choices. */
export function effectiveAgentSessionOptions(
  record: Pick<AgentSessionRecord, 'options' | 'defaultModelOptions'>
): Record<string, string> | undefined {
  return record.defaultModelOptions === undefined
    ? record.options
    : { ...record.defaultModelOptions, ...record.options }
}

export const AGENT_SESSION_DEFAULT_MODEL_CAPABILITY = 'agent-session.default-model.v1' as const
