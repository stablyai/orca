import { sha256 } from './sha256'

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
