import type { AgentSessionUsageLimit } from '../agent-session/failures/agent-session-usage-limit'
import { usageLimitResetsAt } from '../agent-session/failures/agent-session-usage-limit'
import { claudeUsageLimitWindow } from '../agent-session/failures/provider-usage-limit'
import { parseAgentHookJson } from './request-body'
import { scanFileRegionsBackward } from './reverse-file-region-scan'
import { TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_SCAN_BYTES } from './transcript-reader'
import { readString } from './tool-input-preview'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

export type ClaudeTerminalUsageLimit = {
  messageId: string
  usageLimit: AgentSessionUsageLimit
}

export function readClaudeTerminalUsageLimitForHook(
  eventName: unknown,
  payload: Record<string, unknown>
): AgentSessionUsageLimit | undefined {
  if (
    eventName !== 'StopFailure' ||
    payload.error !== 'rate_limit' ||
    readString(payload, 'agent_id') !== undefined
  ) {
    return undefined
  }
  const sessionId = readString(payload, 'session_id')
  const promptId = readString(payload, 'prompt_id')
  const transcriptPath = readString(payload, 'transcript_path')
  return sessionId && promptId && transcriptPath
    ? readClaudeTerminalUsageLimit(transcriptPath, { sessionId, promptId })?.usageLimit
    : undefined
}

function limitOfMessage(message: JsonRecord, now: number): AgentSessionUsageLimit {
  const info = record(record(message.apiErrorParams)?.rate_limit_info)
  if (
    info?.status !== 'rejected' ||
    info.overageStatus === 'allowed' ||
    info.overageStatus === 'allowed_warning' ||
    info.isUsingOverage === true ||
    info.overageInUse === true
  ) {
    return {}
  }
  const window =
    typeof info.rateLimitType === 'string' ? claudeUsageLimitWindow(info.rateLimitType) : undefined
  const resetsAt =
    typeof info.resetsAt === 'number' ? usageLimitResetsAt(info.resetsAt * 1000, now) : undefined
  return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
}

/** Attribute the latest typed quota error to its root prompt; assistant rows have no promptId. */
export function readClaudeTerminalUsageLimit(
  transcriptPath: string,
  expected: { sessionId: string; promptId: string },
  now = Date.now()
): ClaudeTerminalUsageLimit | undefined {
  let candidate: ClaudeTerminalUsageLimit | undefined
  let parentUuid: string | undefined
  return (
    scanFileRegionsBackward<ClaudeTerminalUsageLimit | null>(
      transcriptPath,
      { chunkBytes: TRANSCRIPT_CHUNK_BYTES, maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES },
      (region) => {
        const lines = region.toString('utf8').split('\n')
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const line = lines[index].trim()
          if (!line) {
            continue
          }
          let row: JsonRecord | undefined
          try {
            row = record(parseAgentHookJson(line))
          } catch {
            return null
          }
          if (!row || row.isSidechain === true) {
            continue
          }
          if (row.type !== 'user' && row.type !== 'assistant') {
            if (candidate && row.uuid === parentUuid) {
              parentUuid = typeof row.parentUuid === 'string' ? row.parentUuid : undefined
            }
            continue
          }
          if (row.sessionId !== expected.sessionId || row.isSidechain !== false) {
            return null
          }
          const content = record(row.message)?.content
          const isToolResult =
            Array.isArray(content) && content.some((block) => record(block)?.type === 'tool_result')
          if (row.type === 'user' && !isToolResult) {
            // Native isMeta continuations and compact summaries supersede the old root too.
            return candidate &&
              row.isCompactSummary !== true &&
              row.promptId === expected.promptId &&
              row.uuid === parentUuid
              ? candidate
              : null
          }
          if (!candidate && row.type === 'assistant') {
            if (row.apiError !== 'usage_limit_reached' || typeof row.uuid !== 'string') {
              return null
            }
            candidate = { messageId: row.uuid, usageLimit: limitOfMessage(row, now) }
            parentUuid = typeof row.parentUuid === 'string' ? row.parentUuid : undefined
          } else if (candidate && row.uuid === parentUuid) {
            parentUuid = typeof row.parentUuid === 'string' ? row.parentUuid : undefined
          }
        }
        return undefined
      }
    ) ?? undefined
  )
}
