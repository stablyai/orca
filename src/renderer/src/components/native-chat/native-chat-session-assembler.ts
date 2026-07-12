import {
  isTextBlock,
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession,
  type NativeChatSessionStatus
} from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'
import { isLaunchPromptMessageId, isPendingMessageId } from './native-chat-pending'

/** Messages grouped by source. Higher-priority sources (transcript > hook >
 *  scrape) supersede lower ones when they describe the same turn. */
export type NativeChatSources = {
  transcript?: NativeChatMessage[]
  hook?: NativeChatMessage[]
  scrape?: NativeChatMessage[]
}

export type AssembleNativeChatSessionInput = {
  sources: NativeChatSources
  sessionId: string | null
  agent: AgentType
  /** Overrides the derived status. The derived value is 'empty' when no
   *  messages survive merge, otherwise 'ready'. Callers pass 'loading',
   *  'working', or 'error' when out-of-band signals apply. */
  status?: NativeChatSessionStatus
  error?: string
}

// Why: a turn can surface from several sources with different ids (a hook event
// and the transcript record for the same assistant reply rarely share an id).
// We dedup on an explicit `turnId` when present; otherwise fall back to
// role + normalized text so the same logical turn collapses to one message.
// Normalization lowercases and collapses whitespace so cosmetic ANSI/scrape
// differences don't defeat the match. The fallback only ever merges records of
// DIFFERENT sources (gated in mergeOne), so two identical SAME-source prompts
// stay distinct (#10). Timestamp is deliberately NOT folded into the key: a
// scrape copy of a turn often has a null timestamp while the transcript copy
// has a real one, and folding it would wrongly stop that legitimate
// cross-source pair from collapsing.
function turnKey(message: NativeChatMessage): string {
  if (message.turnId) {
    return `turn:${message.turnId}`
  }
  const text = message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  // Why: two same-role messages with no turnId and no text (e.g. distinct
  // tool-call-only turns) would otherwise share `${role}:` and the second would
  // be dropped. Fold a digest of the non-text blocks (tool name+input, result
  // output) into the key so different tool turns stay distinct.
  return `${message.role}:${text}:${nonTextBlockDigest(message)}`
}

function nonTextBlockDigest(message: NativeChatMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'tool-call') {
      parts.push(`call:${block.name}:${stableStringify(block.input)}`)
    } else if (block.type === 'tool-result') {
      parts.push(`result:${block.output}`)
    } else if (block.type === 'image-ref') {
      parts.push(`image:${block.path ?? block.url ?? block.alt ?? ''}`)
    }
  }
  return parts.join('|')
}

function stableStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function supersedes(candidate: NativeChatMessage, existing: NativeChatMessage): boolean {
  const candidateRank = NATIVE_CHAT_SOURCE_PRIORITY[candidate.source]
  const existingRank = NATIVE_CHAT_SOURCE_PRIORITY[existing.source]
  return candidateRank > existingRank
}

// Why: the tail bubbles form fixed tiers that timestamps alone can't express.
// The streaming preview (null timestamp) must follow real content but sit ahead
// of the optimistic composer echoes, which carry finite `sentAt` timestamps that
// would otherwise sort past it. Rank first, then timestamp within a tier.
function messageSortRank(message: NativeChatMessage): number {
  if (message.id === NATIVE_CHAT_STREAMING_ID) {
    return 1
  }
  if (isPendingMessageId(message.id) || isLaunchPromptMessageId(message.id)) {
    return 2
  }
  return 0
}

// Why: null timestamps (sources that can't supply one, e.g. scrape segments)
// sort before any real timestamp within their tier so they don't jump to the
// end. Ties break on id for a stable, deterministic order.
export function compareMessages(a: NativeChatMessage, b: NativeChatMessage): number {
  const ar = messageSortRank(a)
  const br = messageSortRank(b)
  if (ar !== br) {
    return ar - br
  }
  const at = a.timestamp ?? Number.NEGATIVE_INFINITY
  const bt = b.timestamp ?? Number.NEGATIVE_INFINITY
  if (at !== bt) {
    return at - bt
  }
  if (a.id < b.id) {
    return -1
  }
  if (a.id > b.id) {
    return 1
  }
  return 0
}

/**
 * Pure merge of layered conversation sources into a single ordered, deduped
 * `NativeChatSession`. Precedence: transcript > hook > scrape. Dedup happens on
 * message id and on turn key (explicit turnId, else role + normalized text), so
 * the same turn from multiple sources collapses to the highest-priority copy.
 */
export function assembleNativeChatSession(
  input: AssembleNativeChatSessionInput
): NativeChatSession {
  const { sources, sessionId, agent, status, error } = input

  // Process highest priority first so a later, lower-priority duplicate is
  // dropped rather than overwriting. Within a source, order is preserved.
  const ordered: NativeChatMessage[] = [
    ...normalizeImageTranscriptMessages(sources.transcript ?? []),
    ...(sources.hook ?? []),
    // Scrape segments carry the same raw `[Image: source: …]` markers (e.g. from
    // scrollback before the transcript loads), so normalize them too.
    ...normalizeImageTranscriptMessages(sources.scrape ?? [])
  ]

  const byId = new Map<string, NativeChatMessage>()
  const byTurn = new Map<string, NativeChatMessage>()

  for (const message of ordered) {
    mergeOne(byId, byTurn, message)
  }

  const messages = Array.from(byId.values()).sort(compareMessages)

  const derivedStatus: NativeChatSessionStatus = messages.length === 0 ? 'empty' : 'ready'

  return {
    messages,
    status: status ?? derivedStatus,
    sessionId,
    agent,
    ...(error ? { error } : {})
  }
}

/**
 * The single per-message merge rule, shared by the full rebuild and the
 * incremental assembler so there is exactly one copy of the dedup logic.
 * Dedups by `id`, then by `turnKey` — but the turnKey fallback only merges a
 * candidate against an existing message of a DIFFERENT source (#10): the text
 * fallback exists for cross-source dedup, so two distinct same-source records
 * with identical text must never collapse. The explicit-`turnId` path is
 * cross-source identity and is unaffected (it never collides within a source).
 */
export function mergeOne(
  byId: Map<string, NativeChatMessage>,
  byTurn: Map<string, NativeChatMessage>,
  message: NativeChatMessage
): void {
  const existingById = byId.get(message.id)
  if (existingById) {
    if (supersedes(message, existingById)) {
      replace(byId, byTurn, existingById, message)
    }
    return
  }
  const key = turnKey(message)
  const existingByTurn = byTurn.get(key)
  if (existingByTurn && existingByTurn.source !== message.source) {
    if (supersedes(message, existingByTurn)) {
      replace(byId, byTurn, existingByTurn, message)
    }
    return
  }
  // No id match and no cross-source turn match: a distinct record. Indexing it
  // under its turnKey may overwrite a same-source entry that shares the key —
  // that's fine, the turn index only needs one representative per key for the
  // cross-source pass; both distinct records still live in `byId`.
  byId.set(message.id, message)
  byTurn.set(key, message)
}

function replace(
  byId: Map<string, NativeChatMessage>,
  byTurn: Map<string, NativeChatMessage>,
  old: NativeChatMessage,
  next: NativeChatMessage
): void {
  byId.delete(old.id)
  byTurn.delete(turnKey(old))
  byId.set(next.id, next)
  byTurn.set(turnKey(next), next)
}
