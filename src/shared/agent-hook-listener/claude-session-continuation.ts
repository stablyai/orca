import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../agent-session-resume'
import type { AgentHookEventPayload } from './listener-event'
import { scanFileRegionsBackward } from './reverse-file-region-scan'
import { TRANSCRIPT_CHUNK_BYTES } from './transcript-reader'

const FIRST_SCAN_BYTES = 1024 * 1024
// Why: a rescan reads only what was appended, plus enough to re-read a line split at the old end.
const RESCAN_OVERLAP_BYTES = 64 * 1024
const FORK_HEAD_SCAN_BYTES = 256 * 1024
const MAX_CONTINUATION_HOPS = 8
const MAX_REMEMBERED_ENTRIES = 256
// Claude Code accepts only this shape for continuedInSessionId; it also keeps ids out of path joins.
// Claude Code skips tagged text (commands, reminders) and interrupt markers when finding prompts.
const NOT_A_PROMPT = /^\s*<[a-z][\w-]*[\s>]|^\[Request interrupted by user/
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Follows the `continued-in` record Claude Code writes when it forks a pane's session into a
 * daemon job. That job's hooks are declined (#15304), so the pane's own transcript is the only
 * evidence of where the conversation went.
 */
export class ClaudeSessionContinuationTracker {
  /** Last scan per transcript, so an unchanged file is not re-read while its fork is pending. */
  private readonly scanByTranscript = new Map<string, { size: number; pointer?: string }>()
  /** A session `/clear` started inside a job → that job's first session, which names its state dir. */
  private readonly jobSessionBySession = new Map<string, string>()

  resolve(session: AgentProviderSessionMetadata): AgentProviderSessionMetadata | null {
    const visited = new Set([session.id])
    let current = session
    for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop++) {
      const next = this.findNextSession(current)
      if (!next || visited.has(next.id)) {
        break
      }
      visited.add(next.id)
      current = next
    }
    return current === session ? null : current
  }

  private findNextSession(
    session: AgentProviderSessionMetadata
  ): AgentProviderSessionMetadata | null {
    const transcriptPath = session.transcriptPath
    if (session.key !== 'session_id' || !transcriptPath?.endsWith('.jsonl')) {
      return null
    }
    // Why before the size memo: after `/clear` the old transcript stops growing, so only the job's
    // state says where the conversation went.
    const jobSessionId = this.jobSessionBySession.get(session.id) ?? session.id
    const cleared = resolveClearedJobSession(transcriptPath, jobSessionId, session)
    if (cleared) {
      remember(this.jobSessionBySession, cleared.id, jobSessionId)
      return cleared
    }
    let size: number
    try {
      size = statSync(transcriptPath).size
    } catch {
      return null
    }
    const scan = this.scanByTranscript.get(transcriptPath)
    let pointer = scan?.pointer
    if (scan?.size !== size) {
      const isRescan = scan !== undefined && scan.size < size
      const found = readContinuationPointer(
        transcriptPath,
        session.id,
        isRescan ? size - scan.size + RESCAN_OVERLAP_BYTES : FIRST_SCAN_BYTES
      )
      // Why keep the old pointer on an empty rescan: only the appended bytes were read.
      pointer = found === undefined && isRescan ? scan.pointer : (found ?? undefined)
      remember(this.scanByTranscript, transcriptPath, { size, pointer })
    }
    // Why retry a remembered pointer: its fork may reach disk after the old file stops growing.
    return pointer ? resolveForkedSession(transcriptPath, pointer, session.cwd) : null
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_REMEMBERED_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
}

/** The fork a pane's Claude row should now point at. A fork another pane reports belongs to that
 *  pane, whose own hooks keep it current. */
export function resolvePaneClaudeContinuation(
  tracker: ClaudeSessionContinuationTracker,
  rows: ReadonlyMap<string, AgentHookEventPayload>,
  paneKey: string
): AgentProviderSessionMetadata | null {
  const row = rows.get(paneKey)
  if (
    !row?.providerSession ||
    row.payload.agentType !== 'claude' ||
    row.providerSessionOnly ||
    row.structuredHost
  ) {
    return null
  }
  const next = tracker.resolve(row.providerSession)
  if (!next) {
    return null
  }
  for (const [otherPaneKey, other] of rows) {
    if (otherPaneKey !== paneKey && other.providerSession?.id === next.id) {
      return null
    }
  }
  return next
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined
  } catch {
    return undefined
  }
}

/** The newest pointer out of `sessionId`, or null when a later turn continued this session
 *  instead (close to Claude Code's own reader); undefined when the scan saw neither. */
function readContinuationPointer(
  transcriptPath: string,
  sessionId: string,
  maxScanBytes: number
): string | null | undefined {
  return scanFileRegionsBackward<{ pointer: string | null }>(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes },
    (region) => {
      const lines = region.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index--) {
        const text = lines[index]
        if (
          !text.includes('"continued-in"') &&
          !text.includes('"type":"user"') &&
          !text.includes('"type":"assistant"')
        ) {
          continue
        }
        const record = parseRecord(text.trim())
        if (
          record?.type === 'continued-in' &&
          record.sessionId === sessionId &&
          isClaudeSessionId(record.continuedInSessionId)
        ) {
          return { pointer: record.continuedInSessionId }
        }
        if (record && isCompletedTurn(record)) {
          return { pointer: null }
        }
      }
      return undefined
    }
  )?.pointer
}

/** A real prompt or a finished, non-error reply: the old session went on after any older pointer. */
function isCompletedTurn(record: Record<string, unknown>): boolean {
  const message = record.message
  const fields =
    typeof message === 'object' && message !== null && !Array.isArray(message)
      ? Object.fromEntries(Object.entries(message))
      : {}
  if (record.type === 'assistant') {
    return record.isApiErrorMessage !== true && typeof fields.stop_reason === 'string'
  }
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
    return false
  }
  const content: unknown = fields.content
  const texts: unknown[] = typeof content === 'string' ? [content] : []
  if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result')) {
      return false
    }
    texts.push(...content.filter((block) => block?.type === 'text').map((block) => block.text))
  }
  return texts.some(
    (text) => typeof text === 'string' && text.trim() !== '' && !NOT_A_PROMPT.test(text)
  )
}

function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SESSION_ID.test(value)
}

function resolveForkedSession(
  transcriptPath: string,
  forkedSessionId: string,
  cwd: string | undefined
): AgentProviderSessionMetadata | null {
  const forkedPath = findForkedTranscript(transcriptPath, forkedSessionId)
  if (!forkedPath || !forkHeadNamesSession(forkedPath, forkedSessionId)) {
    return null
  }
  return normalizeAgentProviderSession({
    key: 'session_id',
    id: forkedSessionId,
    transcriptPath: forkedPath,
    cwd
  })
}

/** The fork lives beside the old transcript; the job's state names it when the file is not `<id>.jsonl`. */
function findForkedTranscript(transcriptPath: string, sessionId: string): string | undefined {
  const byId = path.join(path.dirname(transcriptPath), `${sessionId}.jsonl`)
  if (isFile(byId)) {
    return byId
  }
  const state = readJobState(transcriptPath, sessionId)
  return state && isSiblingFile(transcriptPath, state.linkScanPath) ? state.linkScanPath : undefined
}

/** `/clear` inside a job starts a new transcript without writing `continued-in`; the job's state
 *  keeps its first session id and names the current one as `resumeSessionId`. */
function resolveClearedJobSession(
  transcriptPath: string,
  jobSessionId: string,
  session: AgentProviderSessionMetadata
): AgentProviderSessionMetadata | null {
  const state = readJobState(transcriptPath, jobSessionId)
  if (
    !state ||
    !isClaudeSessionId(state.resumeSessionId) ||
    state.resumeSessionId === session.id ||
    !isSiblingFile(transcriptPath, state.linkScanPath) ||
    !forkHeadNamesSession(state.linkScanPath, state.resumeSessionId)
  ) {
    return null
  }
  return normalizeAgentProviderSession({
    key: 'session_id',
    id: state.resumeSessionId,
    transcriptPath: state.linkScanPath,
    cwd: session.cwd
  })
}

type JobState = { linkScanPath: unknown; resumeSessionId: unknown }

/** <config>/projects/<cwd slug>/<id>.jsonl → <config>/jobs/<first 8 of id>/state.json, when it is this session's job. */
function readJobState(transcriptPath: string, sessionId: string): JobState | undefined {
  if (!isClaudeSessionId(sessionId)) {
    return undefined
  }
  const configDir = path.dirname(path.dirname(path.dirname(transcriptPath)))
  const statePath = path.join(configDir, 'jobs', sessionId.slice(0, 8), 'state.json')
  let state: Record<string, unknown> | undefined
  try {
    state = parseRecord(readFileSync(statePath, 'utf8'))
  } catch {
    return undefined
  }
  return state?.sessionId === sessionId
    ? { linkScanPath: state.linkScanPath, resumeSessionId: state.resumeSessionId }
    : undefined
}

function isSiblingFile(transcriptPath: string, candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    path.dirname(candidate) === path.dirname(transcriptPath) &&
    isClaudeSessionId(path.basename(candidate, '.jsonl')) &&
    path.extname(candidate) === '.jsonl' &&
    isFile(candidate)
  )
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** The fork's own records must carry the new id; a stray file under that name proves nothing. */
function forkHeadNamesSession(forkedPath: string, sessionId: string): boolean {
  let head: string
  try {
    const fd = openSync(forkedPath, 'r')
    try {
      const buffer = Buffer.alloc(FORK_HEAD_SCAN_BYTES)
      const read = readSync(fd, buffer, 0, FORK_HEAD_SCAN_BYTES, 0)
      head = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
  // Why a substring: a huge first record would not parse inside the head window.
  return head.includes(`"sessionId":"${sessionId}"`)
}
