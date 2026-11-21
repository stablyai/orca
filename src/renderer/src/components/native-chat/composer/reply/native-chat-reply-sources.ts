// Which message each accepted reply answered, keyed by its chat and the exact text sent. A reply
// rebuilt from that text in the same chat (Rewind, "not sent → Edit", a queued edit) gets its
// original back even when another message has the same words; another chat never borrows it.
// Small and bounded, so localStorage holds it across reloads.

// v2 keys each record by its chat; v1 records named no chat, so they're not trusted and are dropped.
const STORAGE_KEY = 'orca.nativeChat.replySources.v2'
const LEGACY_STORAGE_KEY = 'orca.nativeChat.replySources.v1'
/** Sent replies remembered at once; older ones are dropped first. */
export const NATIVE_CHAT_REPLY_SOURCES_MAX = 200

const sources = new Map<string, string>()
/** Recorded for text sent in reply to more than one message. As a reply's original it names no
 *  message, so the original reads as unavailable instead of being guessed from its words. */
export const NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS = 'orca:ambiguous-reply-source'
const AMBIGUOUS = NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS
let loaded = false

/** A compact key for sent text: its length and two independent 32-bit hashes (FNV-1a and a
 *  multiply-rotate mix), so two different texts of the same length don't share a key in practice. */
function keyOf(text: string): string {
  let fnv = 0x811c9dc5
  let mix = 0x9747b28c
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    fnv = Math.imul(fnv ^ code, 0x01000193)
    mix = Math.imul(mix ^ code, 0x5bd1e995)
    mix = (mix << 13) | (mix >>> 19)
  }
  return `${text.length}:${(fnv >>> 0).toString(36)}:${(mix >>> 0).toString(36)}`
}

function load(): void {
  if (loaded) {
    return
  }
  loaded = true
  try {
    globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY)
    const entries: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]')
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        sources.set(entry[0], entry[1])
      }
    }
  } catch {
    // Unreadable storage only costs the exact original; the words still find it when unique.
  }
}

/** A send carrying `sentText` was accepted: remember which message it answers. The same text sent
 *  in reply to a different message is ambiguous, so neither keeps an exact original. */
export function rememberNativeChatReplySource(
  /** The chat's message box scope: a record is only read back in the chat that sent it. */
  conversation: string,
  sentText: string,
  messageId: string
): void {
  if (!messageId || !conversation) {
    return
  }
  load()
  const key = scopedKeyOf(conversation, sentText)
  const known = sources.get(key)
  sources.delete(key)
  sources.set(key, known === undefined || known === messageId ? messageId : AMBIGUOUS)
  while (sources.size > NATIVE_CHAT_REPLY_SOURCES_MAX) {
    const oldest = sources.keys().next().value
    if (oldest === undefined) {
      break
    }
    sources.delete(oldest)
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...sources]))
  } catch {
    // Quota or blocked storage: this session still remembers it.
  }
}

/** The message a sent reply answered, when this client sent it. */
export function nativeChatReplySourceOf(
  conversation: string,
  sentText: string
): string | undefined {
  if (!conversation) {
    return undefined
  }
  load()
  return sources.get(scopedKeyOf(conversation, sentText))
}

function scopedKeyOf(conversation: string, sentText: string): string {
  return `${conversation}\n${keyOf(sentText)}`
}

/** Test-only: forget all sources and reload from storage on next read. */
export function resetNativeChatReplySourcesForTests(): void {
  sources.clear()
  loaded = false
}
