import {
  MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS,
  isAgentSessionProviderHandleChain,
  isAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  decodePersistedAgentSessionProviderHandle,
  encodePersistedAgentSessionProviderHandle,
  type PersistedAgentSessionProviderHandle
} from './agent-session-provider-handle-encoding'

/** A link as a record row stores it: only the handle has a stored form of its own. */
export type PersistedAgentSessionProviderHandleLink = Omit<
  AgentSessionProviderHandleLink,
  'handle'
> & {
  handle: PersistedAgentSessionProviderHandle
}

export function encodePersistedAgentSessionProviderHandleChain(
  chain: AgentSessionProviderHandleChain
): PersistedAgentSessionProviderHandleLink[] {
  return chain.map((link) => ({
    ...link,
    handle: encodePersistedAgentSessionProviderHandle(link.handle)
  }))
}

/** The in-memory chain a stored one names, or null when any link or the chain itself is invalid. */
export function decodePersistedAgentSessionProviderHandleChain(
  value: unknown,
  inactive?: unknown,
  clearedThrough = -1
): AgentSessionProviderHandleLink[] | null {
  if (!Array.isArray(value) || (inactive !== undefined && !Array.isArray(inactive))) {
    return null
  }
  const archived: unknown[] = inactive ?? []
  if (value.length + archived.length > MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
    return null
  }
  const decoded: AgentSessionProviderHandleLink[] = []
  for (const link of [...archived, ...value]) {
    const handle =
      typeof link === 'object' && link !== null && 'handle' in link
        ? decodePersistedAgentSessionProviderHandle(link.handle)
        : null
    if (!handle) {
      return null
    }
    const candidate: unknown = { ...link, handle }
    if (!isAgentSessionProviderHandleLink(candidate)) {
      return null
    }
    if (candidate.mintedAtFence > clearedThrough) {
      decoded.push(candidate)
    }
  }
  if (archived.length !== 0) {
    decoded.sort((left, right) => left.mintedAtFence - right.mintedAtFence)
  }
  return isAgentSessionProviderHandleChain(decoded) ? decoded : null
}
