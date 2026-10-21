// Why: jcode hooks carry no user-prompt field, so the listener reads the last
// user message from jcode's on-disk session state: the live `.journal.jsonl`
// append log first (authoritative while the session is active), then the
// consolidated `session_*.json` document. Bounded like the Grok/Command Code
// transcript readers so hook events stay cheap on multi-megabyte sessions.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scanFileRegionsBackward } from './agent-hook-listener/reverse-file-region-scan'

const JCODE_SESSION_ID_MAX_LENGTH = 512
const JCODE_SESSION_SCAN_BYTES = 4 * 1024 * 1024
const JCODE_JOURNAL_CHUNK_BYTES = 64 * 1024
const JCODE_JSON_DOC_MAX_PARSE_BYTES = 8 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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
    if (isRecord(block) && typeof block.text === 'string') {
      parts.push(block.text)
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

/** Absolute byte offset of `lines[index]`. Why not the region-local index: the scan
 *  window slides as the journal grows, so the same record would key differently on a
 *  later read and a repeated turn_end would slip past the same-hash dedupe. */
function lineByteOffset(lines: readonly string[], index: number, regionPosition: number): number {
  let offset = regionPosition
  for (let i = 0; i < index; i += 1) {
    offset += Buffer.byteLength(lines[i] ?? '', 'utf8') + 1
  }
  return offset
}

function readLastUserMessageFromJournalLines(
  lines: readonly string[],
  sessionId: string,
  regionPosition: number
): JcodeUserPromptEvidence | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[index] ?? '')
    } catch {
      continue
    }
    if (!isRecord(entry)) {
      continue
    }
    const appendMessages = entry.append_messages
    if (!Array.isArray(appendMessages)) {
      continue
    }
    for (let messageIndex = appendMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const record = appendMessages[messageIndex]
      if (!isRecord(record)) {
        continue
      }
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
          `${lineByteOffset(lines, index, regionPosition)}:${messageIndex}:${text}`
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
  return (
    scanFileRegionsBackward(
      journalPath,
      { chunkBytes: JCODE_JOURNAL_CHUNK_BYTES, maxScanBytes: JCODE_SESSION_SCAN_BYTES },
      (region, regionPosition) =>
        readLastUserMessageFromJournalLines(
          region.toString('utf8').split('\n'),
          sessionId,
          regionPosition
        ) ?? undefined
    ) ?? null
  )
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
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'))
    if (!isRecord(parsed)) {
      return null
    }
    const messages = parsed.messages
    if (!Array.isArray(messages)) {
      return null
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const record = messages[index]
      if (!isRecord(record)) {
        continue
      }
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
