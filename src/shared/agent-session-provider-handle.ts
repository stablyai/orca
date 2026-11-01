/** Handles expose transport, agent and conversation ID; adapters alone read resumeCursor (encoding lives separately). Resumes extend a chain; forks change its root. Supersede unsaved creations in place; replace lost saved conversations with a following creation so forgotten history remains attributable. */

import type { AgentType } from './agent-status-types'
import {
  agentSessionProviderHandleReplacementsEqual,
  isAgentSessionProviderHandleReplacement,
  type AgentSessionProviderHandleReplacement
} from './agent-session-provider-handle-replacement'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  decodePersistedAgentSessionProviderHandle,
  encodePersistedAgentSessionProviderHandle,
  isAgentSessionProviderHandle,
  isAgentSessionProviderHandleInNamespace,
  isAgentSessionProviderHandleKeyFor,
  type PersistedAgentSessionProviderHandle
} from './agent-session-provider-handle-encoding'

export type { AgentSessionProviderHandleReplacement } from './agent-session-provider-handle-replacement'
export {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  isAgentSessionProviderHandle,
  isStructuredAgentId
} from './agent-session-provider-handle-encoding'

/** Built-ins are only the fallback list; hosts advertise registered-agents and publish additional agents/capabilities through agentSession.agents. */
export const AGENT_SESSION_PROVIDER_HANDLE_PROVIDERS = ['claude', 'codex'] as const

export type AgentSessionHandleProvider = (typeof AGENT_SESSION_PROVIDER_HANDLE_PROVIDERS)[number]

/** A host-registered agent slug; isStructuredAgentId checks syntax, the host registry checks availability. */
export type StructuredAgentId = string

/** Built-in-specific features only; structured-chat support requires a valid agent slug and host registration. */
export function isAgentSessionHandleProvider(value: unknown): value is AgentSessionHandleProvider {
  return value === 'claude' || value === 'codex'
}

/** The protocol whose id space a handle's `nativeId` lives in. Open: a new transport adds no arm. */
export type AgentSessionProviderTransport = 'claude-sdk' | 'codex-app-server' | (string & {})

export type AgentSessionProviderHandle = {
  /** nativeId namespace may differ from the current transport; a mismatch prevents resume, never record loading. */
  transport: AgentSessionProviderTransport
  /** Orca agent whose binary resumes the conversation; one transport serves many agents. */
  agent: AgentType
  /** The provider's own conversation id: Claude's session id, Codex's thread id. */
  nativeId: string
  /** Adapter-owned resume state; shared code never parses it. Only Claude's legacy key includes its cursor as identity. */
  resumeCursor?: string
}

/** Which provider a handle belongs to. Records and leases compare this, never the handle's data. */
export type AgentSessionProviderHandleNamespace = Pick<
  AgentSessionProviderHandle,
  'transport' | 'agent'
>

export type AgentSessionProviderHandleOrigin = 'created' | 'adopted' | 'resumed' | 'forked'

export type AgentSessionProviderHandleLink = {
  /** Stable id so a lease can name the exact link its owner proved. */
  linkId: string
  handle: AgentSessionProviderHandle
  origin: AgentSessionProviderHandleOrigin
  /** Runtime fence in force when this link was minted; never decreases along the chain. */
  mintedAtFence: number
  observedAt: number
  /** Key of the link a fork was seeded from. Only set when `origin` is `forked`. */
  forkedFromKey?: string
  /** Key of the unsaved creation this creation replaced. Only set when `origin` is `created`. */
  supersedesKey?: string
  /** The saved conversation this creation took over from. Only set when `origin` is `created`. */
  replaces?: AgentSessionProviderHandleReplacement
}

export type AgentSessionProviderHandleChain = readonly AgentSessionProviderHandleLink[]

/** Bounded so one session cannot grow an unbounded persisted record. */
export const MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS = 256

const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Every field, resume cursor included: a resume that only moved the adapter's state is still news. */
export function agentSessionProviderHandlesEqual(
  left: AgentSessionProviderHandle,
  right: AgentSessionProviderHandle
): boolean {
  return (
    left.transport === right.transport &&
    left.agent === right.agent &&
    left.nativeId === right.nativeId &&
    left.resumeCursor === right.resumeCursor
  )
}

export function agentSessionProviderHandleChainHead(
  chain: AgentSessionProviderHandleChain
): AgentSessionProviderHandleLink | null {
  return chain.at(-1) ?? null
}

export function findAgentSessionProviderHandleLink(
  chain: AgentSessionProviderHandleChain,
  linkId: string
): AgentSessionProviderHandleLink | null {
  return chain.find((link) => link.linkId === linkId) ?? null
}

export function isAgentSessionProviderHandleLink(
  value: unknown
): value is AgentSessionProviderHandleLink {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const link = value as Partial<AgentSessionProviderHandleLink>
  if (!isAgentSessionProviderHandle(link.handle)) {
    return false
  }
  const handle = link.handle
  const originValid =
    link.origin === 'created' ||
    link.origin === 'adopted' ||
    link.origin === 'resumed' ||
    link.origin === 'forked'
  return (
    typeof link.linkId === 'string' &&
    LINK_ID_PATTERN.test(link.linkId) &&
    originValid &&
    Number.isSafeInteger(link.mintedAtFence) &&
    (link.mintedAtFence as number) >= 0 &&
    Number.isSafeInteger(link.observedAt) &&
    (link.origin === 'forked'
      ? isAgentSessionProviderHandleKeyFor(handle, link.forkedFromKey)
      : link.forkedFromKey === undefined) &&
    (link.supersedesKey === undefined ||
      (link.origin === 'created' &&
        isAgentSessionProviderHandleKeyFor(handle, link.supersedesKey))) &&
    (link.replaces === undefined ||
      (link.origin === 'created' && isAgentSessionProviderHandleReplacement(handle, link.replaces)))
  )
}

export function isAgentSessionProviderHandleChain(
  value: unknown
): value is AgentSessionProviderHandleLink[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
    return false
  }
  let validated: AgentSessionProviderHandleLink[] = []
  try {
    for (const link of value) {
      if (!isAgentSessionProviderHandleLink(link)) {
        return false
      }
      const next = appendLink(validated, link, true)
      // A persisted chain must name every link exactly once; retry elision belongs at append time.
      if (next.length !== validated.length + 1) {
        return false
      }
      validated = next
    }
    return true
  } catch {
    return false
  }
}

/** Reject forks presented as resumes and stale-fence writes that would rewrite the chain. */
export function appendAgentSessionProviderHandleLink(
  chain: AgentSessionProviderHandleChain,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink[] {
  return appendLink(chain, link, false)
}

/** `supersededHead`: the replacement already took the place of a creation no longer in `chain`. */
function appendLink(
  chain: AgentSessionProviderHandleChain,
  link: AgentSessionProviderHandleLink,
  supersededHead: boolean
): AgentSessionProviderHandleLink[] {
  if (!isAgentSessionProviderHandleLink(link)) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const head = agentSessionProviderHandleChainHead(chain)
  if (!head) {
    // A replacement names the conversation before it, so it can never open a chain.
    if ((link.origin !== 'created' && link.origin !== 'adopted') || link.replaces !== undefined) {
      throw new Error('agent_session_provider_handle_invalid')
    }
    return [link]
  }
  if (!isAgentSessionProviderHandleInNamespace(link.handle, head.handle)) {
    throw new Error('agent_session_provider_handle_provider_mismatch')
  }
  if (link.mintedAtFence < head.mintedAtFence) {
    throw new Error('agent_session_provider_handle_stale_fence')
  }
  const sameRoot =
    agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle)
  if (link.origin === 'created') {
    if (link.supersedesKey !== undefined && !supersededHead) {
      return supersedeUnsavedCreation(chain, head, link)
    }
    if (
      link.replaces === undefined ||
      link.replaces.key !== agentSessionProviderHandleKey(head.handle) ||
      sameRoot
    ) {
      throw new Error('agent_session_provider_handle_invalid')
    }
    return appendNewLink(chain, link)
  }
  if (link.origin === 'adopted') {
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (link.origin === 'resumed' && !sameRoot) {
    // A changed root is a fork; calling it a resume would claim continuity the provider never gave.
    throw new Error('agent_session_provider_handle_forked')
  }
  if (link.origin === 'forked') {
    if (sameRoot) {
      throw new Error('agent_session_provider_handle_invalid')
    }
    if (link.forkedFromKey !== agentSessionProviderHandleKey(head.handle)) {
      throw new Error('agent_session_provider_handle_invalid')
    }
  }
  if (
    link.origin === 'resumed' &&
    agentSessionProviderHandlesEqual(link.handle, head.handle) &&
    link.mintedAtFence === head.mintedAtFence
  ) {
    // Why: re-proving the same handle at the same fence is a retry, not a new identity.
    return [...chain]
  }
  return appendNewLink(chain, link)
}

function appendNewLink(
  chain: AgentSessionProviderHandleChain,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink[] {
  if (findAgentSessionProviderHandleLink(chain, link.linkId)) {
    // Why: the lease names its exact proof by link id; reuse would make that reference ambiguous.
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (chain.length >= MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
    // Refuse at the cap and let the caller roll the journal epoch; dropping links would erase fork provenance.
    throw new Error('agent_session_provider_handle_chain_overflow')
  }
  return [...chain, link]
}

/** Replace only an unsaved created head with a named new identity root; resumed/forked/adopted heads prove saved conversations. Pass replacement provenance through supersession so lost history stays recorded. */
function supersedeUnsavedCreation(
  chain: AgentSessionProviderHandleChain,
  head: AgentSessionProviderHandleLink,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink[] {
  const earlier = chain.slice(0, -1)
  if (
    head.origin !== 'created' ||
    link.supersedesKey !== agentSessionProviderHandleKey(head.handle) ||
    agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle) ||
    (link.replaces !== undefined &&
      !agentSessionProviderHandleReplacementsEqual(link.replaces, head.replaces)) ||
    link.linkId === head.linkId
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const next = head.replaces ? { ...link, replaces: head.replaces } : link
  // Why: in place, so a chat reopened unused across many restarts never grows toward the cap.
  return earlier.length === 0 ? [next] : appendLink(earlier, next, true)
}

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
  value: unknown
): AgentSessionProviderHandleLink[] | null {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
    return null
  }
  const decoded: unknown[] = []
  for (const link of value) {
    const handle =
      typeof link === 'object' && link !== null && 'handle' in link
        ? decodePersistedAgentSessionProviderHandle(link.handle)
        : null
    if (!handle) {
      return null
    }
    decoded.push({ ...link, handle })
  }
  return isAgentSessionProviderHandleChain(decoded) ? decoded : null
}
