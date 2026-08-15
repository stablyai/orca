// Why: jcode hooks carry no user-prompt field, so the listener reads the last
// user message from jcode's on-disk session state: the live `.journal.jsonl`
// append log first (authoritative while the session is active), then the
// consolidated `session_*.json` document. Bounded like the Grok/Command Code
// transcript readers so hook events stay cheap on multi-megabyte sessions.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const JCODE_SESSION_ID_MAX_LENGTH = 512
const JCODE_SESSION_SCAN_BYTES = 4 * 1024 * 1024
const JCODE_JOURNAL_CHUNK_BYTES = 64 * 1024
const JCODE_JSON_DOC_MAX_PARSE_BYTES = 8 * 1024 * 1024
const EMPTY_REGION = Buffer.alloc(0)

export function resolveJcodeSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir()
): string {
  const explicit = env.JCODE_HOME?.trim()
  return explicit ? join(explicit, 'sessions') : join(homeDir, '.jcode', 'sessions')
}

function isSafeJcodeSessionId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > JCODE_SESSION_ID_MAX_LENGTH) {
    return false
  }
  // Why: session ids embed a timestamp and a hex suffix; reject anything with
  // separators or control characters so no path traversal reaches the fs.
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed)
}

function sessionFilePath(sessionId: string): string {
  return join(resolveJcodeSessionsDir(), `${sessionId}.json`)
}

function sessionJournalPath(sessionId: string): string {
  return join(resolveJcodeSessionsDir(), `${sessionId}.journal.jsonl`)
}

/** Text of one jcode stored message: string content or `[{type:'text',text}]`. */
function messageText(message: Record<string, unknown>): string | null {
  const content = message.content
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>).text
      if (typeof text === 'string') {
        parts.push(text)
      }
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > 0 ? joined : null
}

/** True for jcode's injected session-context envelope (role user, display_role system). */
function isInjectedContextMessage(message: Record<string, unknown>): boolean {
  return message.display_role === 'system' || message.role === 'system'
}

export type JcodeUserPromptEvidence = {
  text: string
  interactionKey: string
}

function buildInteractionKey(source: 'journal' | 'json', sessionId: string, salt: string): string {
  return [
    'jcode-transcript',
    source,
    createHash('sha256').update(sessionId).digest('hex').slice(0, 12),
    createHash('sha256').update(salt).digest('hex').slice(0, 12)
  ].join('-')
}

function readLastUserMessageFromJournalLines(
  lines: readonly string[],
  sessionId: string
): JcodeUserPromptEvidence | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[index] ?? '')
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const appendMessages = (entry as Record<string, unknown>).append_messages
    if (!Array.isArray(appendMessages)) {
      continue
    }
    for (let messageIndex = appendMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = appendMessages[messageIndex]
      if (typeof message !== 'object' || message === null) {
        continue
      }
      const record = message as Record<string, unknown>
      if (record.role !== 'user' || isInjectedContextMessage(record)) {
        continue
      }
      const text = messageText(record)
      if (!text || text.startsWith('<system-reminder>')) {
        continue
      }
      return {
        text,
        interactionKey: buildInteractionKey(
          'journal',
          sessionId,
          `${index}:${messageIndex}:${text}`
        )
      }
    }
  }
  return null
}

function readLastUserMessageFromJournal(
  journalPath: string,
  sessionId: string
): JcodeUserPromptEvidence | null {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(journalPath)
  } catch {
    return null
  }
  if (stats.size <= 0) {
    return null
  }
  try {
    const fd = openSync(journalPath, 'r')
    try {
      // Why backward scan: the last user message is near EOF; the first hit
      // returns instead of parsing a multi-megabyte log from the top.
      let carryChunks: Buffer[] = []
      let bytesRead = 0
      let scanEnd = stats.size
      while (scanEnd > 0 && bytesRead < JCODE_SESSION_SCAN_BYTES) {
        const chunkSize = Math.min(
          scanEnd,
          JCODE_JOURNAL_CHUNK_BYTES,
          JCODE_SESSION_SCAN_BYTES - bytesRead
        )
        const position = scanEnd - chunkSize
        const buffer = Buffer.alloc(chunkSize)
        const filled = readSync(fd, buffer, 0, chunkSize, position)
        if (filled < chunkSize) {
          break
        }
        bytesRead += filled
        scanEnd = position
        const firstNewline = buffer.indexOf(0x0a)
        const atStart = position === 0
        let completeRegion: Buffer
        if (atStart) {
          completeRegion =
            carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
          carryChunks = []
        } else if (firstNewline === -1) {
          completeRegion = EMPTY_REGION
          carryChunks.unshift(buffer)
        } else {
          const afterNewline = buffer.subarray(firstNewline + 1)
          completeRegion =
            carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
          carryChunks = [buffer.subarray(0, firstNewline)]
        }
        if (completeRegion.length > 0) {
          const lines = completeRegion.toString('utf8').split('\n')
          const found = readLastUserMessageFromJournalLines(lines, sessionId)
          if (found) {
            return found
          }
        }
      }
      return null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function readLastUserMessageFromJson(
  jsonPath: string,
  sessionId: string
): JcodeUserPromptEvidence | null {
  let size = 0
  try {
    size = statSync(jsonPath).size
  } catch {
    return null
  }
  if (size <= 0 || size > JCODE_JSON_DOC_MAX_PARSE_BYTES) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const messages = (parsed as Record<string, unknown>).messages
    if (!Array.isArray(messages)) {
      return null
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (typeof message !== 'object' || message === null) {
        continue
      }
      const record = message as Record<string, unknown>
      if (record.role !== 'user' || isInjectedContextMessage(record)) {
        continue
      }
      const text = messageText(record)
      if (!text || text.startsWith('<system-reminder>')) {
        continue
      }
      return { text, interactionKey: buildInteractionKey('json', sessionId, `${index}:${text}`) }
    }
    return null
  } catch {
    return null
  }
}

/** Last real user prompt for a jcode session, or null when none is recoverable. */
export function readLastJcodeUserPromptFromHookPayload(
  hookPayload: Record<string, unknown>
): JcodeUserPromptEvidence | null {
  const sessionId = hookPayload.session_id ?? hookPayload.sessionId
  if (!isSafeJcodeSessionId(sessionId)) {
    return null
  }
  return (
    readLastUserMessageFromJournal(sessionJournalPath(sessionId), sessionId) ??
    readLastUserMessageFromJson(sessionFilePath(sessionId), sessionId)
  )
}
