import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'
import { sha256 } from './sha256'

/** Stable child identity, with the parent's timestamp so both expire on the same schedule. */
export function deriveAgentLaunchChildOperationId(operationId: string): string | null {
  const timestamp = parseAgentSessionOperationTimestamp(operationId)
  if (timestamp === null) {
    return null
  }
  // These fixed keys are in canonical order; the preimage must match existing saved operations.
  const bytes = sha256(
    new TextEncoder().encode(JSON.stringify({ child: 'agent.launch:attach', operationId }))
  )
  const entropy = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
  return `${timestamp}-${entropy}`
}
