import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { AgentHookSource } from '../agent-hook-relay'
import {
  buildGrokChatHistoryPathCandidates,
  findGrokChatHistoryBySessionId,
  getCachedGrokChatHistoryBySessionId,
  GROK_SESSION_ID_MAX_LENGTH,
  isSafeGrokSessionId,
  resolveGrokChatHistoryPathSync,
  resolveGrokSessionsDir
} from '../grok-session-paths'
import { readFirstString } from './interactive-tool'
import { parseAgentHookJson } from './request-body'
import { GROK_HOME_ENVELOPE_MAX_LENGTH, GROK_SESSION_CWD_MAX_LENGTH } from './listener-limits'
import { readLastAssistantFromTranscriptOnce } from './transcript-reader'
import { isGrokEvent } from './provider-event-names'
import { isAntigravityStopStillBusy } from './providers/antigravity-event-rules'

export function parseHookBodyPayloadRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const rawPayload = (body as Record<string, unknown>).payload
  const payload =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return parseAgentHookJson(rawPayload)
          } catch {
            return null
          }
        })()
      : rawPayload
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null
}

export function readBoundedString(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxLength: number
): string | undefined {
  const value = readFirstString(record, keys)
  return value && value.length <= maxLength ? value : undefined
}

export function readGrokHomeEnvelope(record: Record<string, unknown>): string | undefined {
  const value = readBoundedString(record, ['grokHome'], GROK_HOME_ENVELOPE_MAX_LENGTH)
  if (!value || value !== value.trim() || !isAbsolute(value) || hasControlCharacter(value)) {
    return undefined
  }
  return value
}

export function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

type GrokSessionMetadata = {
  sessionId: string
  cwd?: string
  sessionsDir: string
}

export function readGrokSessionMetadata(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): GrokSessionMetadata | undefined {
  const sessionId = readBoundedString(
    hookPayload,
    ['sessionId', 'session_id'],
    GROK_SESSION_ID_MAX_LENGTH
  )
  if (!sessionId || !isSafeGrokSessionId(sessionId)) {
    return undefined
  }
  const cwd = readBoundedString(
    hookPayload,
    ['cwd', 'workspaceRoot', 'workspace_root'],
    GROK_SESSION_CWD_MAX_LENGTH
  )
  // Why: hook scripts report the effective per-PTY/remote Grok home; old scripts fall back to the runtime's for compatibility.
  const sessionsDir = grokHome
    ? join(grokHome, 'sessions')
    : resolveGrokSessionsDir(process.env, homedir())
  return { sessionId, cwd, sessionsDir }
}

export function getGrokChatHistoryPath(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): string | undefined {
  const metadata = readGrokSessionMetadata(hookPayload, grokHome)
  if (!metadata) {
    return undefined
  }
  const resolved = resolveGrokChatHistoryPathSync({
    sessionId: metadata.sessionId,
    cwd: metadata.cwd ?? null,
    sessionsDir: metadata.sessionsDir
  })
  if (resolved) {
    return resolved
  }
  const cached = getCachedGrokChatHistoryBySessionId(metadata.sessionsDir, metadata.sessionId)
  if (cached) {
    return cached
  }
  // Why: SessionEnd can race the last write; return a plausible on-disk candidate (short-cwd preferred) even if the file doesn't exist yet.
  if (!metadata.cwd) {
    return undefined
  }
  return (
    buildGrokChatHistoryPathCandidates({
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      sessionsDir: metadata.sessionsDir
    })[0] ?? undefined
  )
}

export function readLastAssistantFromGrokChatHistory(
  hookPayload: Record<string, unknown>,
  grokHome?: string
): string | undefined {
  const chatHistoryPath = getGrokChatHistoryPath(hookPayload, grokHome)
  if (!chatHistoryPath) {
    return undefined
  }
  return readLastAssistantFromTranscriptOnce(chatHistoryPath)
}

export function hasPendingAgentResultText(source: AgentHookSource, body: unknown): boolean {
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const record = parseHookBodyPayloadRecord(body)
  if (!record) {
    return false
  }
  if (hasExplicitLastAssistantResult(record)) {
    return false
  }
  if (source === 'copilot') {
    // Why: Copilot Stop uses generic `message` as final assistant text; Grok/Antigravity use that field for status instead.
    if (hasNonEmptyString(record.message)) {
      return false
    }
    const transcriptPath = record.transcript_path ?? record.transcriptPath
    return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
  }
  const eventName =
    envelope?.hook_event_name ??
    envelope?.hookEventName ??
    record.hook_event_name ??
    record.hookEventName
  if (source === 'antigravity' && eventName === 'Stop') {
    if (isAntigravityStopStillBusy(record)) {
      return false
    }
    const transcriptPath = record.transcriptPath ?? record.transcript_path
    return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
  }
  const pendingGrokDiscovery = preparePendingGrokResultDiscovery(source, body)
  if (pendingGrokDiscovery) {
    void pendingGrokDiscovery
    return true
  }
  return false
}

export function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function hasExplicitLastAssistantResult(record: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(record.last_assistant_message) ||
    hasNonEmptyString(record.lastAssistantMessage)
  )
}

/** Start bounded discovery only for a Grok completion that still needs result text. */
export function preparePendingGrokResultDiscovery(
  source: AgentHookSource,
  body: unknown
): Promise<void> | null {
  if (source !== 'grok') {
    return null
  }
  const envelope =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  const record = parseHookBodyPayloadRecord(body)
  if (!record || hasExplicitLastAssistantResult(record)) {
    return null
  }
  const eventName =
    envelope?.hook_event_name ??
    envelope?.hookEventName ??
    record.hook_event_name ??
    record.hookEventName
  if (!isGrokEvent(eventName, 'stop', 'session_end')) {
    return null
  }
  const metadata = readGrokSessionMetadata(
    record,
    envelope ? readGrokHomeEnvelope(envelope) : undefined
  )
  if (!metadata) {
    return null
  }
  // Why: lets the server await discovery without moving filesystem I/O back into synchronous hook normalization.
  return findGrokChatHistoryBySessionId(metadata.sessionsDir, metadata.sessionId).then(
    () => undefined
  )
}
