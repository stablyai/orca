/**
 * Durable provider handle chain for an agent session.
 *
 * A handle names one provider conversation without saying what the provider means by it. Shared
 * code reads only its transport, its agent, and the provider's own conversation id; anything else
 * the provider needs to resume is `resumeCursor`, which only that provider's adapter reads. How a
 * handle is stored and sent lives in agent-session-provider-handle-encoding.ts.
 *
 * Resumes extend the chain, forks start a new identity root, and the chain records which is which
 * so a fork is never presented as a resume. A creation the provider never saved can be superseded
 * by a new creation, which takes its place instead of standing beside it: the unsaved handle was
 * never a conversation to continue.
 */

import type { AgentType } from './agent-status-types'
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

export {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  isAgentSessionProviderHandle
} from './agent-session-provider-handle-encoding'

/** The structured lanes this build drives. A record names one; a handle never does. */
export const AGENT_SESSION_PROVIDER_HANDLE_PROVIDERS = ['claude', 'codex'] as const

export type AgentSessionHandleProvider = (typeof AGENT_SESSION_PROVIDER_HANDLE_PROVIDERS)[number]

/** Runtime guard for persisted/remote provider metadata. Unknown values must not impersonate Codex. */
export function isAgentSessionHandleProvider(value: unknown): value is AgentSessionHandleProvider {
  return value === 'claude' || value === 'codex'
}

/** The protocol whose id space a handle's `nativeId` lives in. Open: a new transport adds no arm. */
export type AgentSessionProviderTransport = 'claude-sdk' | 'codex-app-server' | (string & {})

export type AgentSessionProviderHandle = {
  /**
   * The id space `nativeId` was minted in, which can differ from the agent's current transport. A
   * mismatch with the running build makes the chat not resumable there, never the record unreadable.
   */
  transport: AgentSessionProviderTransport
  /** Orca agent whose binary resumes the conversation; one transport serves many agents. */
  agent: AgentType
  /** The provider's own conversation id: Claude's session id, Codex's thread id. */
  nativeId: string
  /**
   * Adapter-owned resume position (Claude: transcript leaf). Shared code never parses it; it is never
   * identity, except inside Claude's legacy handle key.
   */
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
      (link.origin === 'created' && isAgentSessionProviderHandleKeyFor(handle, link.supersedesKey)))
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
      const next = appendAgentSessionProviderHandleLink(validated, link)
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

/**
 * Append one link, rejecting anything that would let a fork masquerade as a resume or let a
 * late writer rewrite the chain under an older fence.
 */
export function appendAgentSessionProviderHandleLink(
  chain: AgentSessionProviderHandleChain,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink[] {
  if (!isAgentSessionProviderHandleLink(link)) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const head = agentSessionProviderHandleChainHead(chain)
  if (!head) {
    if (link.origin !== 'created' && link.origin !== 'adopted') {
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
  if (link.origin === 'created' && link.supersedesKey !== undefined) {
    return supersedeUnsavedCreation(head, link)
  }
  if (link.origin === 'created' || link.origin === 'adopted') {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const sameRoot =
    agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle)
  if (link.origin === 'resumed' && !sameRoot) {
    // Why: a resume that lands on another identity root forked; recording it as a resume would
    // make Orca claim continuity the provider never gave.
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
  if (findAgentSessionProviderHandleLink(chain, link.linkId)) {
    // Why: the lease names its exact proof by link id; reuse would make that reference ambiguous.
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (chain.length >= MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
    // Why: dropping older links would erase fork provenance, so refuse and let the caller roll
    // the journal epoch instead of silently losing where this conversation came from.
    throw new Error('agent_session_provider_handle_chain_overflow')
  }
  return [...chain, link]
}

/**
 * Replace the chain's only link, a creation the provider proved it never saved, with the creation
 * that took its place. Every other head names a conversation the provider held (a resume or fork
 * proved it, an adoption imported it), so only a `created` head can be superseded, and only by a
 * new identity root that names it.
 */
function supersedeUnsavedCreation(
  head: AgentSessionProviderHandleLink,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink[] {
  if (
    head.origin !== 'created' ||
    link.supersedesKey !== agentSessionProviderHandleKey(head.handle) ||
    agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle) ||
    link.linkId === head.linkId
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  // Why: in place, so a chat reopened unused across many restarts never grows toward the cap.
  return [link]
}

// ─── Stored form ────────────────────────────────────────────────────────────

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
