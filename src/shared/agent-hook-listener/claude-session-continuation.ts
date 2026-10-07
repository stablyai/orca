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
const MAX_REMEMBERED_TRANSCRIPTS = 256

/**
 * Follows the `continued-in` record Claude Code writes when it forks a pane's session into a
 * daemon job. That job's hooks are declined (#15304), so the pane's own transcript is the only
 * evidence of where the conversation went.
 */
export class ClaudeSessionContinuationTracker {
  /** Transcript size at the last scan that found no pointer, so an unchanged file is not re-read. */
  private readonly scannedSizeByTranscript = new Map<string, number>()

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
    let size: number
    try {
      size = statSync(transcriptPath).size
    } catch {
      return null
    }
    const scannedSize = this.scannedSizeByTranscript.get(transcriptPath)
    if (scannedSize === size) {
      return null
    }
    const maxScanBytes =
      scannedSize !== undefined && scannedSize < size
        ? size - scannedSize + RESCAN_OVERLAP_BYTES
        : FIRST_SCAN_BYTES
    const pointer = readContinuationPointer(transcriptPath, session.id, maxScanBytes)
    if (!pointer) {
      this.rememberScannedSize(transcriptPath, size)
      return null
    }
    // Why not remember a pointer whose fork is not on disk yet: the old file stops growing after it.
    return resolveForkedSession(transcriptPath, pointer)
  }

  private rememberScannedSize(transcriptPath: string, size: number): void {
    this.scannedSizeByTranscript.delete(transcriptPath)
    this.scannedSizeByTranscript.set(transcriptPath, size)
    while (this.scannedSizeByTranscript.size > MAX_REMEMBERED_TRANSCRIPTS) {
      const oldest = this.scannedSizeByTranscript.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.scannedSizeByTranscript.delete(oldest)
    }
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
  if (!next || rows.get(paneKey) !== row) {
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

/** The newest pointer out of `sessionId`; it need not be the last line of the transcript. */
export function readContinuationPointer(
  transcriptPath: string,
  sessionId: string,
  maxScanBytes: number
): string | undefined {
  return scanFileRegionsBackward(
    transcriptPath,
    { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes },
    (region) => {
      const lines = region.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index--) {
        const record = lines[index].includes('"continued-in"')
          ? parseRecord(lines[index].trim())
          : undefined
        if (
          record?.type === 'continued-in' &&
          record.sessionId === sessionId &&
          typeof record.continuedInSessionId === 'string'
        ) {
          return record.continuedInSessionId
        }
      }
      return undefined
    }
  )
}

function resolveForkedSession(
  transcriptPath: string,
  forkedSessionId: string
): AgentProviderSessionMetadata | null {
  const candidate = normalizeAgentProviderSession({ key: 'session_id', id: forkedSessionId })
  if (!candidate) {
    return null
  }
  const forkedPath = findForkedTranscript(transcriptPath, candidate.id)
  if (!forkedPath || !forkHeadNamesSession(forkedPath, candidate.id)) {
    return null
  }
  return normalizeAgentProviderSession({ ...candidate, transcriptPath: forkedPath })
}

/** The fork lives beside the old transcript; the job's state names it when the file is not `<id>.jsonl`. */
function findForkedTranscript(transcriptPath: string, sessionId: string): string | undefined {
  const directory = path.dirname(transcriptPath)
  const byId = path.join(directory, `${sessionId}.jsonl`)
  if (isFile(byId)) {
    return byId
  }
  // <config>/projects/<cwd slug>/<id>.jsonl → <config>/jobs/<first 8 of id>/state.json
  const configDir = path.dirname(path.dirname(directory))
  const statePath = path.join(configDir, 'jobs', sessionId.slice(0, 8), 'state.json')
  let state: Record<string, unknown> | undefined
  try {
    state = parseRecord(readFileSync(statePath, 'utf8'))
  } catch {
    return undefined
  }
  const linkScanPath = state?.linkScanPath
  if (
    state?.sessionId !== sessionId ||
    typeof linkScanPath !== 'string' ||
    path.dirname(linkScanPath) !== directory ||
    !isFile(linkScanPath)
  ) {
    return undefined
  }
  return linkScanPath
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
  // Why drop the last line: the read may have cut it mid-record.
  return head
    .split('\n')
    .slice(0, -1)
    .some((line) => parseRecord(line.trim())?.sessionId === sessionId)
}
