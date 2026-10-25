import { sha256 } from './sha256'
import type {
  StructuredAgentSessionFirstMessage,
  StructuredAgentSessionResumeSource
} from './structured-agent-session-create'
import type { StructuredAgentId } from './agent-session-provider-handle'

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
}

export function structuredAgentSessionPayloadFingerprint(input: {
  method: string
  sessionId: string
  fields: Record<string, unknown>
}): string {
  const bytes = sha256(
    new TextEncoder().encode(
      canonicalize({ method: input.method, sessionId: input.sessionId, fields: input.fields })
    )
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function structuredAgentSessionDomainFingerprint(input: {
  domain: string
  sessionId: string
  fields: Record<string, unknown>
}): string {
  return structuredAgentSessionPayloadFingerprint({
    method: input.domain,
    sessionId: input.sessionId,
    fields: input.fields
  })
}

export function structuredAgentSessionCreateFingerprint(input: {
  sessionId: string
  worktree: string
  agent: StructuredAgentId
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  options?: Readonly<Record<string, string>>
}): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.create',
    sessionId: input.sessionId,
    fields: {
      worktree: input.worktree,
      agent: input.agent,
      // Dropping undefined preserves blank-create digests; resume intent must not replay as blank create.
      resumeFrom: input.resumeFrom,
      // Include tabId in the host digest; retries replay its recorded host-owned ID.
      tabId: input.tabId,
      firstMessage: input.firstMessage,
      options: input.options
    }
  })
}

export function createStructuredAgentSessionOperationId(
  randomUuid: () => string,
  now: number = Date.now()
): string {
  const timestamp = Math.trunc(now).toString()
  const entropy = randomUuid().replaceAll('-', '').toLowerCase()
  if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(entropy)) {
    throw new Error('Unable to create a durable operation id')
  }
  return `${timestamp}-${entropy}`
}
