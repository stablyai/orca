import type { AgentSessionRecord } from './agent-session-record'
import { isRecord } from './agent-status-child-work-value-guards'
import {
  agentSessionProviderHandleRoot,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'

type AgentSessionProviderTranscript = NonNullable<AgentSessionRecord['providerTranscript']>

export function isOptionalAgentSessionTranscript(
  value: unknown
): value is AgentSessionProviderTranscript | undefined {
  if (value === undefined) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }
  const transcript = value
  return (
    typeof transcript.path === 'string' &&
    transcript.path.length <= 4096 &&
    !transcript.path.includes('\0') &&
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(transcript.path) &&
    typeof transcript.handleRoot === 'string' &&
    transcript.handleRoot.length > 0 &&
    transcript.handleRoot.length <= 2048
  )
}

/** Called only inside the successful, fenced owner-proof transaction. */
export function withAgentSessionProviderTranscript(
  record: AgentSessionRecord,
  input: { link: AgentSessionProviderHandleLink; transcriptPath?: string | null }
): AgentSessionRecord {
  if (!input.transcriptPath) {
    return record
  }
  const providerTranscript = {
    path: input.transcriptPath,
    handleRoot: agentSessionProviderHandleRoot(input.link.handle)
  }
  if (!isOptionalAgentSessionTranscript(providerTranscript)) {
    throw new Error('agent_session_operation_invalid')
  }
  return { ...record, providerTranscript }
}
