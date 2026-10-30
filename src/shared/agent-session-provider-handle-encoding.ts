/** Keep Claude/Codex typed stored/wire forms for older builds; other transports use a neutral form older readers refuse. Each identity has exactly one encoding and immutable persisted key/root strings. Handle fields are closed and rewrites drop extras: put future per-link data on the preserved chain link. */

import type {
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

/** The typed lanes' namespaces: their handles can only ever be stored in these. */
function builtInHandleNamespace(agent: string): AgentSessionProviderHandleNamespace | null {
  return agent === CLAUDE_STRUCTURED_HANDLE_NAMESPACE.agent
    ? CLAUDE_STRUCTURED_HANDLE_NAMESPACE
    : agent === CODEX_STRUCTURED_HANDLE_NAMESPACE.agent
      ? CODEX_STRUCTURED_HANDLE_NAMESPACE
      : null
}

export function isAgentSessionProviderHandleInNamespace(
  handle: AgentSessionProviderHandleNamespace,
  namespace: AgentSessionProviderHandleNamespace
): boolean {
  return handle.transport === namespace.transport && handle.agent === namespace.agent
}

/** Compare namespace only. Claude/Codex are pinned to typed transports; other agents may use any single namespace owned by that agent. Check transport drivability at start via agentDrivesSession, never while loading records. */
export function agentSessionProviderHandleBelongsTo(
  handle: AgentSessionProviderHandle,
  agent: string
): boolean {
  const builtIn = builtInHandleNamespace(agent)
  return builtIn ? isAgentSessionProviderHandleInNamespace(handle, builtIn) : handle.agent === agent
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

/** Validate the bounded agent slug; the host registry alone decides whether it runs there. */
export function isStructuredAgentId(value: unknown): value is string {
  return isNamespacePart(value)
}

function isLegacyNamespace(handle: AgentSessionProviderHandleNamespace): boolean {
  return (
    isAgentSessionProviderHandleInNamespace(handle, CLAUDE_STRUCTURED_HANDLE_NAMESPACE) ||
    isAgentSessionProviderHandleInNamespace(handle, CODEX_STRUCTURED_HANDLE_NAMESPACE)
  )
}

/** Whether builds before the neutral handle read a record of this namespace at all. */
export function isAgentSessionProviderHandleReadByOlderBuilds(
  handle: AgentSessionProviderHandleNamespace
): boolean {
  return isLegacyNamespace(handle)
}

/** In-memory Claude/Codex handles must fit their typed stored forms: Claude resumes at a leaf; Codex has no cursor. */
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
  // Both encodings would name two identities and erase one on rewrite; refuse the row.
  if (
    Object.hasOwn(value, 'provider') &&
    NEUTRAL_HANDLE_FIELDS.some((field) => Object.hasOwn(value, field))
  ) {
    return null
  }
  const provider = 'provider' in value ? value.provider : undefined
  if (provider === 'claude') {
    const sessionId = 'sessionId' in value ? value.sessionId : undefined
    // Missing and null leaves were never equivalent stored values; continue refusing missing leaves.
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
  // Resume cursors are adapter state, not identity, except Claude's leaf whose legacy persisted keys are fixed.
  return agentSessionProviderHandleRoot(handle)
}

/** A changed identity root is a fork regardless of what the provider calls it. */
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

/** Journal handle for diagnostics only; nothing reads it back. */
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
