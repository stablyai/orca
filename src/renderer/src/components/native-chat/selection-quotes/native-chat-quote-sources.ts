import { beginLinkOpenRequest } from '@/lib/links/link-open-request'

// Where a quote came from. The app's windows on this computer share this list, and it stays after a
// restart. It holds short hashes of the quoted text, not the text. The agent never gets it.
const STORAGE_KEY = 'orca.nativeChat.quoteSources'
const LIMIT = 200

/** Where the quote is in its source element's text, and a hash of the text there. */
export type QuotePlace = { offset: number; length: number; hash: string }
/** `chat` is the transcript the message is in; sources stored before it have none. */
export type QuoteSource = { messageId: string; place: QuotePlace | null; chat?: string }

type Entry = [
  key: string,
  messageId: string,
  offset: number,
  length: number,
  hash: string,
  chat?: string
]

/** FNV-1a over UTF-16 code units, with the length: short, and the same in each window. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`
}

/**
 * The quote as "Add to chat" writes it: the text with no trailing whitespace on a line, and no
 * whitespace at its two ends. Both sides hash this source text, never the rendered quote.
 */
function quoteKey(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  return normalized ? textHash(normalized) : ''
}

// Read on each use: another window can write between two calls.
function load(): Entry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Entry =>
            Array.isArray(entry) &&
            (entry.length === 5 || (entry.length === 6 && typeof entry[5] === 'string')) &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string' &&
            typeof entry[2] === 'number' &&
            typeof entry[3] === 'number' &&
            typeof entry[4] === 'string'
        )
      : []
  } catch {
    return []
  }
}

/** Remembers the chat message, and the place in it, that "Add to chat" quoted `text` from. */
export function rememberNativeChatQuoteSource(text: string, source: QuoteSource): void {
  const key = quoteKey(text)
  if (!key) {
    return
  }
  const { offset = -1, length = 0, hash = '' } = source.place ?? {}
  const entry: Entry = [key, source.messageId, offset, length, hash, source.chat ?? '']
  const entries = [...load().filter(([known]) => known !== key), entry].slice(-LIMIT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Without storage, the quote has no message source; its file header can still jump.
  }
}

/** The source of a quote, found by the quote's source text. */
export function nativeChatQuoteSource(text: string): QuoteSource | null {
  const key = quoteKey(text)
  const entry = key ? load().find(([known]) => known === key) : undefined
  if (!entry) {
    return null
  }
  const [, messageId, offset, length, hash, chat] = entry
  return {
    messageId,
    place: offset >= 0 ? { offset, length, hash } : null,
    ...(chat ? { chat } : {})
  }
}

export type QuotedFileLocation = { pathText: string; line: number }

/**
 * The file of an editor or Markdown preview quote: a header line, then a code fence. The header is
 * `path:12`, `path:12-20`, or a path with no line, which opens at line 1.
 */
export function quotedFileLocation(
  firstLine: string,
  followedByFence: boolean
): QuotedFileLocation | null {
  const text = firstLine.trim()
  if (!followedByFence || !text) {
    return null
  }
  const lines = /^(.+):(\d+)(?:-\d+)?$/.exec(text)
  if (lines) {
    return { pathText: lines[1], line: Number(lines[2]) }
  }
  // A terminal quote is a title and a code fence too. A title that looks like a path opens as a file.
  return !text.includes(':') && /\/|\.[A-Za-z0-9]+$/.test(text) ? { pathText: text, line: 1 } : null
}

export type NativeChatQuoteJumpDeps = {
  /**
   * Shows the message in this transcript and highlights the quote; false when the source is in
   * another chat. It pages older history in when the message is not loaded. Calls
   * `notifyMissing` when no page has the message, or when the message is not drawn after the
   * jump. Each later step does nothing once `isCurrent` is false.
   */
  jumpToMessage:
    | ((
        source: QuoteSource,
        text: string,
        notifyMissing: () => void,
        isCurrent: () => boolean
      ) => boolean)
    | null
  /** Opens the file at the line and highlights it; false when the chat cannot open it. */
  openFile: ((location: QuotedFileLocation) => boolean) | null
  notifyMissing: () => void
}

/**
 * Goes back to where a sent quote came from: its chat message, else its file, else a notice.
 * `text` is the quote's source text, without the `>` marks.
 */
export function jumpToQuoteSource(
  text: string,
  deps: NativeChatQuoteJumpDeps
): 'message' | 'file' | 'missing' {
  // Each chip click is one link open: it stops the later steps of every earlier one.
  const isCurrent = beginLinkOpenRequest()
  const source = nativeChatQuoteSource(text)
  if (source && deps.jumpToMessage?.(source, text, deps.notifyMissing, isCurrent)) {
    return 'message'
  }
  const [firstLine = '', secondLine = ''] = text.split('\n')
  const location = quotedFileLocation(firstLine, /^\s*(?:```|~~~)/.test(secondLine))
  if (location && deps.openFile?.(location)) {
    return 'file'
  }
  deps.notifyMissing()
  return 'missing'
}
