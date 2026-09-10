import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'

export const AGENT_SESSION_PREFIX_MAX_ENTRIES = 10_000
export const AGENT_SESSION_PREFIX_MAX_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2
export const AGENT_SESSION_PREFIX_MAX_PAGES = 100

export function agentSessionPrefixWithinBounds(items: readonly unknown[]): boolean {
  return (
    items.length <= AGENT_SESSION_PREFIX_MAX_ENTRIES &&
    new TextEncoder().encode(JSON.stringify(items)).byteLength <= AGENT_SESSION_PREFIX_MAX_BYTES
  )
}
