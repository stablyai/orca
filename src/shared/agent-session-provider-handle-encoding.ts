/**
 * How a provider handle is stored and sent, and the only module that knows the two typed shapes
 * the first structured transports were stored in.
 *
 * Claude and Codex handles are persisted and sent exactly as before this module existed, so an
 * older build sharing the database or the wire still reads them. Every other transport is stored
 * in the neutral shape, which an older build refuses as unreadable rather than mistaking for one
 * of its own. Decoding is strict: each handle has exactly one stored form, and the key and root
 * strings derived from it are persisted elsewhere, so none of them may ever change.
 *
 * A stored handle has a closed field set, and a rewrite drops anything else. A later build adds new
 * per-link data on the chain link, which every build preserves, never on the handle.
 */

import type {
  AgentSessionHandleProvider,
  AgentSessionProviderHandle,
  AgentSessionProviderHandleNamespace
} from './agent-session-provider-handle'
import type {
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from './agent-session-journal-types'

export const CLAUDE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'claude-sdk',
  agent: 'claude'
} as const satisfies AgentSessionProviderHandleNamespace

export const CODEX_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'codex-app-server',
  agent: 'codex'
} as const satisfies AgentSessionProviderHandleNamespace

/** The namespace a record's handles live in, from the structured lane it was created on. */
export function agentSessionProviderHandleNamespace(
  provider: AgentSessionHandleProvider
): AgentSessionProviderHandleNamespace {
  return provider === 'claude'
    ? CLAUDE_STRUCTURED_HANDLE_NAMESPACE
    : CODEX_STRUCTURED_HANDLE_NAMESPACE
}

export function isAgentSessionProviderHandleInNamespace(
  handle: AgentSessionProviderHandleNamespace,
  namespace: AgentSessionProviderHandleNamespace
): boolean {
  return handle.transport === namespace.transport && handle.agent === namespace.agent
}

/** Whether a handle belongs to a record of this lane. Compares namespaces; never reads its data. */
export function agentSessionProviderHandleBelongsTo(
  handle: AgentSessionProviderHandle,
  provider: AgentSessionHandleProvider
): boolean {
  return isAgentSessionProviderHandleInNamespace(
    handle,
    agentSessionProviderHandleNamespace(provider)
  )
}

/** Claude's resume cursor is its leaf: the transcript entry a resume continues from. */
export function claudeProviderHandle(
  sessionId: string,
  leafUuid: string | null
): AgentSessionProviderHandle {
  return {
    ...CLAUDE_STRUCTURED_HANDLE_NAMESPACE,
    nativeId: sessionId,
    ...(leafUuid === null ? {} : { resumeCursor: leafUuid })
  }
}

export function claudeProviderHandleLeafUuid(handle: AgentSessionProviderHandle): string | null {
  return handle.resumeCursor ?? null
}

export function codexProviderHandle(threadId: string): AgentSessionProviderHandle {
  return { ...CODEX_STRUCTURED_HANDLE_NAMESPACE, nativeId: threadId }
}

// ─── Validation ─────────────────────────────────────────────────────────────

const MAX_HANDLE_FIELD_LENGTH = 512
/** A generic handle's key carries escaped ids, so it may outgrow a legacy key's bound. */
const MAX_NEUTRAL_HANDLE_KEY_LENGTH = 8192
const MAX_RESUME_CURSOR_LENGTH = 4096
const NAMESPACE_PART_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function isAgentSessionProviderHandleField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HANDLE_FIELD_LENGTH &&
    value === value.trim()
  )
}

function isNamespacePart(value: unknown): value is string {
  return typeof value === 'string' && NAMESPACE_PART_PATTERN.test(value)
}

function isLegacyNamespace(handle: AgentSessionProviderHandleNamespace): boolean {
  return (
    isAgentSessionProviderHandleInNamespace(handle, CLAUDE_STRUCTURED_HANDLE_NAMESPACE) ||
    isAgentSessionProviderHandleInNamespace(handle, CODEX_STRUCTURED_HANDLE_NAMESPACE)
  )
}

/**
 * An in-memory handle. A Claude or Codex handle must also fit its typed stored shape: Claude's
 * resume cursor is a leaf id, and Codex has none.
 */
export function isAgentSessionProviderHandle(value: unknown): value is AgentSessionProviderHandle {
  if (typeof value !== 'object' || value === null || Object.hasOwn(value, 'provider')) {
    return false
  }
  const transport = 'transport' in value ? value.transport : undefined
  const agent = 'agent' in value ? value.agent : undefined
  const nativeId = 'nativeId' in value ? value.nativeId : undefined
  const resumeCursor = 'resumeCursor' in value ? value.resumeCursor : undefined
  if (
    !isNamespacePart(transport) ||
    !isNamespacePart(agent) ||
    !isAgentSessionProviderHandleField(nativeId)
  ) {
    return false
  }
  const namespace = { transport, agent }
  if (isAgentSessionProviderHandleInNamespace(namespace, CODEX_STRUCTURED_HANDLE_NAMESPACE)) {
    return resumeCursor === undefined
  }
  if (isAgentSessionProviderHandleInNamespace(namespace, CLAUDE_STRUCTURED_HANDLE_NAMESPACE)) {
    return resumeCursor === undefined || isAgentSessionProviderHandleField(resumeCursor)
  }
  return (
    resumeCursor === undefined ||
    (typeof resumeCursor === 'string' &&
      resumeCursor.length > 0 &&
      resumeCursor.length <= MAX_RESUME_CURSOR_LENGTH)
  )
}

/** Bound for a persisted key that names a handle in this namespace (`forkedFromKey`, `supersedesKey`). */
export function isAgentSessionProviderHandleKeyFor(
  handle: AgentSessionProviderHandle,
  value: unknown
): value is string {
  return isLegacyNamespace(handle)
    ? isAgentSessionProviderHandleField(value)
    : typeof value === 'string' && value.length > 0 && value.length <= MAX_NEUTRAL_HANDLE_KEY_LENGTH
}

// ─── Stored form ────────────────────────────────────────────────────────────

type StoredClaudeProviderHandle = { provider: 'claude'; sessionId: string; leafUuid: string | null }
type StoredCodexProviderHandle = { provider: 'codex'; threadId: string }

/** A handle as a record row stores it. */
export type PersistedAgentSessionProviderHandle =
  | StoredClaudeProviderHandle
  | StoredCodexProviderHandle
  | AgentSessionProviderHandle

export function encodePersistedAgentSessionProviderHandle(
  handle: AgentSessionProviderHandle
): PersistedAgentSessionProviderHandle {
  if (isAgentSessionProviderHandleInNamespace(handle, CLAUDE_STRUCTURED_HANDLE_NAMESPACE)) {
    return { provider: 'claude', sessionId: handle.nativeId, leafUuid: handle.resumeCursor ?? null }
  }
  if (isAgentSessionProviderHandleInNamespace(handle, CODEX_STRUCTURED_HANDLE_NAMESPACE)) {
    return { provider: 'codex', threadId: handle.nativeId }
  }
  return {
    transport: handle.transport,
    agent: handle.agent,
    nativeId: handle.nativeId,
    ...(handle.resumeCursor === undefined ? {} : { resumeCursor: handle.resumeCursor })
  }
}

/** The neutral form's discriminator and identity fields; a typed stored handle carries none of them. */
const NEUTRAL_HANDLE_FIELDS = ['transport', 'agent', 'nativeId', 'resumeCursor'] as const

export function decodePersistedAgentSessionProviderHandle(
  value: unknown
): AgentSessionProviderHandle | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  // Why: a row in both forms names two identities; reading it as either would erase the other on
  // the next write, so it stays unreadable.
  if (
    Object.hasOwn(value, 'provider') &&
    NEUTRAL_HANDLE_FIELDS.some((field) => Object.hasOwn(value, field))
  ) {
    return null
  }
  const provider = 'provider' in value ? value.provider : undefined
  if (provider === 'claude') {
    const sessionId = 'sessionId' in value ? value.sessionId : undefined
    // Why: a null leaf and a missing one were never the same stored value; keep refusing the second.
    const leafUuid = 'leafUuid' in value ? value.leafUuid : undefined
    return isAgentSessionProviderHandleField(sessionId) &&
      (leafUuid === null || isAgentSessionProviderHandleField(leafUuid))
      ? claudeProviderHandle(sessionId, leafUuid)
      : null
  }
  if (provider === 'codex') {
    const threadId = 'threadId' in value ? value.threadId : undefined
    return isAgentSessionProviderHandleField(threadId) ? codexProviderHandle(threadId) : null
  }
  // A Claude or Codex handle has exactly one stored form, the typed one.
  if (!isAgentSessionProviderHandle(value) || isLegacyNamespace(value)) {
    return null
  }
  return {
    transport: value.transport,
    agent: value.agent,
    nativeId: value.nativeId,
    ...(value.resumeCursor === undefined ? {} : { resumeCursor: value.resumeCursor })
  }
}

// ─── Identity strings (persisted: never change them) ────────────────────────

/** Stable string identity for one handle. Two handles with the same key name the same writer target. */
export function agentSessionProviderHandleKey(handle: AgentSessionProviderHandle): string {
  const stored = encodePersistedAgentSessionProviderHandle(handle)
  if ('provider' in stored) {
    return stored.provider === 'claude'
      ? `claude:${JSON.stringify([stored.sessionId, stored.leafUuid])}`
      : `codex:${JSON.stringify(stored.threadId)}`
  }
  // Why: the resume cursor is resume state the adapter owns, not identity; only Claude's leaf, a
  // branch cursor, was ever part of a key, and its key above is fixed by records already written.
  return agentSessionProviderHandleRoot(handle)
}

/**
 * Identity root: the part that a resume must preserve. A resume that changes the root is a fork,
 * whatever the provider called it.
 */
export function agentSessionProviderHandleRoot(handle: AgentSessionProviderHandle): string {
  const stored = encodePersistedAgentSessionProviderHandle(handle)
  if ('provider' in stored) {
    return stored.provider === 'claude'
      ? `claude:${JSON.stringify(stored.sessionId)}`
      : `codex:${JSON.stringify(stored.threadId)}`
  }
  // Namespace parts cannot hold `/` or `:`, so this never reads as a typed root.
  return `${handle.transport}/${handle.agent}:${JSON.stringify(handle.nativeId)}`
}

// ─── Wire and journal forms ─────────────────────────────────────────────────

/** A handle as `agentSession.attach` carries it and an attach fingerprint covers it. */
export type AgentSessionWireProviderHandle = Exclude<
  AgentSessionJournalProviderHandle,
  { kind: 'opaque' }
>

export function agentSessionProviderHandleFromWire(
  wire: AgentSessionWireProviderHandle
): AgentSessionProviderHandle {
  return wire.kind === 'claude'
    ? claudeProviderHandle(wire.sessionId, wire.leafUuid)
    : codexProviderHandle(wire.threadId)
}

/** Null for a transport the attach wire cannot carry. */
export function agentSessionWireProviderHandle(
  handle: AgentSessionProviderHandle
): AgentSessionWireProviderHandle | null {
  const stored = encodePersistedAgentSessionProviderHandle(handle)
  if (!('provider' in stored)) {
    return null
  }
  return stored.provider === 'claude'
    ? { kind: 'claude', sessionId: stored.sessionId, leafUuid: stored.leafUuid }
    : { kind: 'codex', threadId: stored.threadId }
}

/** What a journal row records before the provider has proved any handle. */
export const AGENT_SESSION_PENDING_PROVIDER_HANDLE_VALUE = 'pending'

/** The handle a journal row records for this identity. Write-only: rows keep it for diagnosis,
 *  nothing reads it. */
export function agentSessionJournalProviderHandle(
  identity: Pick<AgentSessionJournalIdentity, 'agent' | 'providerHandle'>
): AgentSessionJournalProviderHandle {
  const handle = identity.providerHandle
  if (!handle) {
    return {
      kind: 'opaque',
      agent: identity.agent,
      value: AGENT_SESSION_PENDING_PROVIDER_HANDLE_VALUE
    }
  }
  return (
    agentSessionWireProviderHandle(handle) ?? {
      kind: 'opaque',
      agent: handle.agent,
      value: handle.nativeId
    }
  )
}
