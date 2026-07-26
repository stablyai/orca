export const HERMES_PRIMARY_OUTPUT_MAX_BYTES = 5 * 1024 * 1024
export const HERMES_SESSION_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
export const HERMES_SESSION_TRANSCRIPT_MAX_MESSAGES = 10_000
export const HERMES_RUN_PAGE_MAX_RETAINED_BYTES = 32 * 1024 * 1024
export const HERMES_RUN_PAGE_MAX_RUNS = 100
export const HERMES_RUN_HYDRATION_CONCURRENCY = 2
export const HERMES_SESSION_RUN_METADATA_MAX_BYTES = 16 * 1024
export const HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR =
  'Run output omitted because this history page exceeds the memory limit'
export const HERMES_SESSION_TRANSCRIPT_TRUNCATED_ERROR =
  'Session transcript truncated because it exceeds the 8 MiB or 10,000-message history limit'

const HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES = HERMES_SESSION_TRANSCRIPT_MAX_BYTES + 1
const HERMES_SESSION_TRANSCRIPT_TRUNCATION_NOTICE = `[${HERMES_SESSION_TRANSCRIPT_TRUNCATED_ERROR}.]`
const HERMES_SESSION_TRANSCRIPT_SOURCE_TRUNCATED_COLUMN = 'orca_source_truncated'

export const HERMES_SESSION_RUN_SELECT_SQL = `SELECT
  CASE WHEN typeof(title) = 'text'
    THEN CAST(substr(CAST(title AS BLOB), 1, ${HERMES_SESSION_RUN_METADATA_MAX_BYTES}) AS TEXT)
    ELSE NULL END AS title,
  CASE WHEN typeof(started_at) IN ('integer', 'real') THEN started_at ELSE NULL END AS started_at,
  CASE WHEN typeof(ended_at) IN ('integer', 'real') THEN ended_at ELSE NULL END AS ended_at,
  CASE WHEN typeof(model) = 'text'
    THEN CAST(substr(CAST(model AS BLOB), 1, ${HERMES_SESSION_RUN_METADATA_MAX_BYTES}) AS TEXT)
    ELSE NULL END AS model,
  CASE WHEN typeof(message_count) IN ('integer', 'real') THEN message_count ELSE NULL END AS message_count,
  CASE WHEN typeof(input_tokens) IN ('integer', 'real') THEN input_tokens ELSE NULL END AS input_tokens,
  CASE WHEN typeof(output_tokens) IN ('integer', 'real') THEN output_tokens ELSE NULL END AS output_tokens
FROM sessions
WHERE id = ?`

export const HERMES_SESSION_TRANSCRIPT_SELECT_SQL = `SELECT
  CAST(substr(CAST(role AS BLOB), 1, ${HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES}) AS TEXT) AS role,
  CAST(substr(CAST(content AS BLOB), 1, ${HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES}) AS TEXT) AS content,
  CAST(substr(CAST(tool_name AS BLOB), 1, ${HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES}) AS TEXT) AS tool_name,
  CAST(substr(CAST(reasoning AS BLOB), 1, ${HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES}) AS TEXT) AS reasoning,
  CAST(substr(CAST(reasoning_content AS BLOB), 1, ${HERMES_SESSION_TRANSCRIPT_FIELD_MAX_BYTES}) AS TEXT) AS reasoning_content,
  CASE WHEN
       length(CAST(role AS BLOB)) > ${HERMES_SESSION_TRANSCRIPT_MAX_BYTES}
    OR length(CAST(content AS BLOB)) > ${HERMES_SESSION_TRANSCRIPT_MAX_BYTES}
    OR length(CAST(tool_name AS BLOB)) > ${HERMES_SESSION_TRANSCRIPT_MAX_BYTES}
    OR length(CAST(reasoning AS BLOB)) > ${HERMES_SESSION_TRANSCRIPT_MAX_BYTES}
    OR length(CAST(reasoning_content AS BLOB)) > ${HERMES_SESSION_TRANSCRIPT_MAX_BYTES}
  THEN 1 ELSE 0 END AS ${HERMES_SESSION_TRANSCRIPT_SOURCE_TRUNCATED_COLUMN}
FROM messages
WHERE session_id = ?
ORDER BY timestamp, id
LIMIT ${HERMES_SESSION_TRANSCRIPT_MAX_MESSAGES + 1}`

type HermesRunPageLimits = {
  maxConcurrent?: number
  maxRetainedBytes?: number
}

type HermesSessionTranscriptLimits = {
  maxBytes?: number
  maxMessages?: number
}

export type FormattedHermesSessionMessages = {
  content: string | null
  truncated: boolean
}

export async function hydrateHermesRunPageWithinLimits<T>(
  refs: readonly T[],
  hydrate: (ref: T) => Promise<unknown>,
  limits: HermesRunPageLimits = {}
): Promise<unknown[]> {
  const maxConcurrent = clampFiniteLimit(limits.maxConcurrent, 1, HERMES_RUN_HYDRATION_CONCURRENCY)
  const maxRetainedBytes = clampFiniteLimit(
    limits.maxRetainedBytes,
    0,
    HERMES_RUN_PAGE_MAX_RETAINED_BYTES
  )
  const results: unknown[] = []
  let retainedBytes = 0
  for (let start = 0; start < refs.length; start += maxConcurrent) {
    const batch = await Promise.all(refs.slice(start, start + maxConcurrent).map(hydrate))
    for (const run of batch) {
      const runBytes = hermesRunOutputByteLength(run)
      if (retainedBytes + runBytes <= maxRetainedBytes) {
        results.push(run)
        retainedBytes += runBytes
      } else {
        results.push(omitHermesRunOutput(run))
      }
    }
  }
  return results
}

export function formatHermesSessionMessagesWithinLimits(
  messages: Iterable<Record<string, unknown>>,
  limits: HermesSessionTranscriptLimits = {}
): FormattedHermesSessionMessages {
  const maxBytes = clampFiniteLimit(limits.maxBytes, 0, HERMES_SESSION_TRANSCRIPT_MAX_BYTES)
  const maxMessages = clampFiniteLimit(
    limits.maxMessages,
    0,
    HERMES_SESSION_TRANSCRIPT_MAX_MESSAGES
  )
  const chunks: string[] = []
  let retainedBytes = 0
  let messageCount = 0
  let truncated = false

  transcript: for (const message of messages) {
    if (messageCount >= maxMessages) {
      truncated = true
      break
    }
    for (const part of formatHermesSessionMessageParts(message, messageCount > 0)) {
      const partBytes = Buffer.byteLength(part)
      if (retainedBytes + partBytes <= maxBytes) {
        chunks.push(part)
        retainedBytes += partBytes
        continue
      }
      const prefix = takeUtf8Prefix(part, maxBytes - retainedBytes)
      if (prefix) {
        chunks.push(prefix)
        retainedBytes += Buffer.byteLength(prefix)
      }
      truncated = true
      break transcript
    }
    messageCount += 1
    if (message[HERMES_SESSION_TRANSCRIPT_SOURCE_TRUNCATED_COLUMN] === 1) {
      truncated = true
      break
    }
  }

  if (truncated) {
    appendTranscriptTruncationNotice(chunks, retainedBytes, maxBytes)
  }
  return { content: chunks.length > 0 ? chunks.join('') : null, truncated }
}

function clampFiniteLimit(value: number | undefined, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return maximum
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function hermesRunOutputByteLength(run: unknown): number {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return 0
  }
  const content = (run as Record<string, unknown>).output_content
  return typeof content === 'string' ? Buffer.byteLength(content) : 0
}

function formatHermesSessionMessageParts(
  message: Record<string, unknown>,
  includeSeparator: boolean
): string[] {
  const role = typeof message.role === 'string' ? message.role : 'message'
  const content = typeof message.content === 'string' ? message.content.trim() : ''
  const toolName = typeof message.tool_name === 'string' ? message.tool_name.trim() : ''
  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content.trim()
      : typeof message.reasoning === 'string'
        ? message.reasoning.trim()
        : ''
  const parts = [
    includeSeparator ? '\n\n---\n\n' : '',
    `## ${role}${toolName ? ` / ${toolName}` : ''}`
  ]
  if (reasoning) {
    parts.push('\n\n### Reasoning\n\n', reasoning)
  }
  parts.push('\n\n', content || '(empty)')
  return parts
}

function appendTranscriptTruncationNotice(
  chunks: string[],
  retainedBytes: number,
  maxBytes: number
): void {
  const separator = chunks.length > 0 ? '\n\n---\n\n' : ''
  const notice = `${separator}${HERMES_SESSION_TRANSCRIPT_TRUNCATION_NOTICE}`
  const boundedNotice = takeUtf8Prefix(notice, maxBytes)
  const noticeBytes = Buffer.byteLength(boundedNotice)
  const targetBytes = maxBytes - noticeBytes
  trimUtf8Chunks(chunks, retainedBytes, targetBytes)
  if (boundedNotice) {
    chunks.push(boundedNotice)
  }
}

function trimUtf8Chunks(chunks: string[], retainedBytes: number, targetBytes: number): void {
  let bytes = retainedBytes
  while (bytes > targetBytes && chunks.length > 0) {
    const lastIndex = chunks.length - 1
    const last = chunks[lastIndex]!
    const lastBytes = Buffer.byteLength(last)
    const allowedBytes = Math.max(0, lastBytes - (bytes - targetBytes))
    if (allowedBytes === 0) {
      chunks.pop()
      bytes -= lastBytes
      continue
    }
    const prefix = takeUtf8Prefix(last, allowedBytes)
    chunks[lastIndex] = prefix
    bytes = bytes - lastBytes + Buffer.byteLength(prefix)
  }
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  if (Buffer.byteLength(value) <= maxBytes) {
    return value
  }
  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  if (low > 0 && isHighSurrogate(value.charCodeAt(low - 1))) {
    low -= 1
  }
  return value.slice(0, low)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function omitHermesRunOutput(run: unknown): unknown {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return { output_content: null, error: HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR }
  }
  const record = run as Record<string, unknown>
  const existingError = typeof record.error === 'string' && record.error ? record.error : null
  return {
    ...record,
    output_content: null,
    error: existingError
      ? `${existingError}; ${HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR}`
      : HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR
  }
}
