// Share stable upsert/optimistic-send keys; percent-encode components before joining to prevent delimiter collisions.

import type { AgentJournalItemIdentity } from './agent-session-journal-types'

const KEY_DELIMITER = ':'
const VERBATIM_BOUNDED_COMPONENT_TAG = '%FF'
const BOUNDED_COMPONENT_PATTERN = /^[\s\S]{0,40}~orca-oversized~(?:[1-9]\d*)~[0-9a-f]{16}$/
const PARSED_JOURNAL_ITEM_KEY = Symbol('parsedJournalItemKey')

type ParsedJournalItemIdentity = AgentJournalItemIdentity & {
  readonly [PARSED_JOURNAL_ITEM_KEY]?: string
}

/** Digest oversized provider IDs so composed keys fit wire page budgets. */
export const MAX_JOURNAL_KEY_COMPONENT_CHARS = 1024

/** Bound oversized/ill-formed UTF-16 with a diagnostic head, length and two hashes over raw code units. This is deterministic and idempotent for revisions/tombstones, distinguishes lone surrogates from U+FFFD, and works in clients without node:crypto. */
export function boundJournalKeyComponent(value: string): string {
  if (value.length <= MAX_JOURNAL_KEY_COMPONENT_CHARS && !hasLoneSurrogate(value)) {
    return value
  }
  const h1 = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, '0')
  const h2 = fnv1a32(value, 0x0100_0193).toString(16).padStart(8, '0')
  return `${wellFormedBoundedHead(value, 40)}~orca-oversized~${value.length}~${h1}${h2}`
}

/** Make the head URI-encodable by dropping cut pairs and replacing lone surrogates; raw-unit hashes preserve identity. Persisted well-formed heads must remain byte-stable across builds. */
function wellFormedBoundedHead(value: string, maxUnits: number): string {
  let head = ''
  let index = 0
  while (index < value.length && index < maxUnits) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (index + 1 >= maxUnits) {
          break
        }
        head += value.charAt(index) + value.charAt(index + 1)
        index += 2
        continue
      }
      head += '�'
      index += 1
      continue
    }
    head += unit >= 0xdc00 && unit <= 0xdfff ? '�' : value.charAt(index)
    index += 1
  }
  return head
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x0100_0193) >>> 0
  }
  return hash >>> 0
}

function encodePart(value: string | number): string {
  const raw = String(value)
  const bounded = boundJournalKeyComponent(raw)
  const encoded = encodeURIComponent(bounded)
  // `%FF` is not valid UTF-8 and cannot be emitted by encodeURIComponent.
  return raw === bounded && isBoundedComponentRepresentation(raw)
    ? `${VERBATIM_BOUNDED_COMPONENT_TAG}${encoded}`
    : encoded
}

function isBoundedComponentRepresentation(value: string): boolean {
  return BOUNDED_COMPONENT_PATTERN.test(value)
}

/** Codex resume renumbers item IDs: key by thread, turn and within-turn ordinal. Forks retain turn IDs, so keep thread identity; Claude forks copy UUIDs, so include session identity. Never key by text. */
export function agentJournalItemKey(identity: AgentJournalItemIdentity): string {
  // Parsed pre-tag digest keys must keep addressing their persisted revision chain.
  const parsedKey = (identity as ParsedJournalItemIdentity)[PARSED_JOURNAL_ITEM_KEY]
  if (parsedKey !== undefined) {
    return parsedKey
  }
  if (identity.provider === 'codex') {
    return [
      'codex',
      encodePart(identity.threadId),
      encodePart(identity.turnId),
      encodePart(identity.ordinal)
    ].join(KEY_DELIMITER)
  }
  if (identity.provider === 'claude') {
    return ['claude', encodePart(identity.sessionId), encodePart(identity.uuid)].join(KEY_DELIMITER)
  }
  if (identity.provider === 'orca') {
    return ['orca', encodePart(identity.clientMessageId)].join(KEY_DELIMITER)
  }
  return [
    'legacy',
    encodePart(identity.agent),
    encodePart(identity.sessionId),
    encodePart(identity.recordId)
  ].join(KEY_DELIMITER)
}

/** Key for the pre-dispatch submission placeholder, before any provider echo. */
export function agentJournalSubmissionKey(clientMessageId: string): string {
  return agentJournalItemKey({ provider: 'orca', clientMessageId })
}

/** Recover identity from a client-held key for revision upserts such as approval answers. Percent-encode components; tag raw values imitating bounded components in the encoded domain. */
export function parseAgentJournalItemKey(key: string): AgentJournalItemIdentity | null {
  // Corrupt percent sequences must return parse failure instead of throwing through replay/open.
  const parts: string[] = []
  let preserveExactKey = false
  for (const part of key.split(KEY_DELIMITER)) {
    const decoded = decodePart(part)
    if (!decoded) {
      return null
    }
    parts.push(decoded.value)
    preserveExactKey ||= decoded.tagged || isBoundedComponentRepresentation(decoded.value)
  }
  const [provider, ...rest] = parts
  if (provider === 'codex' && rest.length === 3) {
    const ordinal = Number(rest[2])
    return Number.isSafeInteger(ordinal) && ordinal >= 0
      ? parsedIdentity(
          { provider, threadId: rest[0] as string, turnId: rest[1] as string, ordinal },
          key,
          preserveExactKey
        )
      : null
  }
  if (provider === 'claude' && rest.length === 2) {
    return parsedIdentity(
      { provider, sessionId: rest[0] as string, uuid: rest[1] as string },
      key,
      preserveExactKey
    )
  }
  if (provider === 'orca' && rest.length === 1) {
    return parsedIdentity({ provider, clientMessageId: rest[0] as string }, key, preserveExactKey)
  }
  if (provider === 'legacy' && rest.length === 3) {
    return parsedIdentity(
      {
        provider,
        agent: rest[0] as string,
        sessionId: rest[1] as string,
        recordId: rest[2] as string
      },
      key,
      preserveExactKey
    )
  }
  return null
}

function decodePart(part: string): { value: string; tagged: boolean } | null {
  const tagged = part.startsWith(VERBATIM_BOUNDED_COMPONENT_TAG)
  try {
    const value = decodeURIComponent(
      tagged ? part.slice(VERBATIM_BOUNDED_COMPONENT_TAG.length) : part
    )
    return !tagged || isBoundedComponentRepresentation(value) ? { value, tagged } : null
  } catch {
    return null
  }
}

function parsedIdentity<T extends AgentJournalItemIdentity>(
  identity: T,
  key: string,
  preserveExactKey: boolean
): T {
  if (preserveExactKey) {
    Object.defineProperty(identity, PARSED_JOURNAL_ITEM_KEY, { value: key })
  }
  return identity
}
