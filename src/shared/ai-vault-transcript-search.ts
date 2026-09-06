import type { AiVaultAgent } from './ai-vault-types'
import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

// Full-transcript content search for Agent Session History ("deep search").
// The vault list filter only matches metadata (title, cwd, newest previews);
// this searches the conversation body so a user can find "the session where
// the agent fixed X" months later. v1 searches local-host transcripts only —
// non-local hosts degrade to an issue row instead of pretending to search.

export const AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS = 250
export const AI_VAULT_TRANSCRIPT_SEARCH_QUERY_MAX_BYTES = 2 * 1024
export const AI_VAULT_TRANSCRIPT_SEARCH_PATH_MAX_LENGTH = 32_768
// Transcripts can be hundreds of MB; a bounded window keeps one search call
// from streaming the whole vault through the main process. Head covers the
// opening ask, tail covers the latest work.
export const AI_VAULT_TRANSCRIPT_SEARCH_HEAD_BUDGET_BYTES = 2 * 1024 * 1024
export const AI_VAULT_TRANSCRIPT_SEARCH_TAIL_BUDGET_BYTES = 1 * 1024 * 1024
export const AI_VAULT_TRANSCRIPT_SEARCH_MIN_QUERY_LENGTH = 2
export const AI_VAULT_TRANSCRIPT_SEARCH_MAX_SNIPPET_LENGTH = 280
export const AI_VAULT_TRANSCRIPT_SEARCH_MATCH_COUNT_CAP = 9999
// Rows are narrow (<60 chars with truncation) and a line can be megabytes long.
// The hit must sit near the FRONT of the snippet window, with only a short lead
// of context, or the truncated tail hides the keyword (and its highlight).
export const AI_VAULT_TRANSCRIPT_SEARCH_SNIPPET_LEAD_CHARS = 32

export type AiVaultTranscriptSearchRequest = {
  agent: AiVaultAgent
  filePath: string
  sessionId?: string
}

export type AiVaultTranscriptSearchArgs = {
  query: string
  requests: readonly AiVaultTranscriptSearchRequest[]
}

export type AiVaultTranscriptSearchMatch = {
  agent: AiVaultAgent
  filePath: string
  sessionId?: string
  matchCount: number
  /** First matched line, control-stripped and windowed around the hit. */
  snippet: string
}

export type AiVaultTranscriptSearchIssue = {
  agent: AiVaultAgent
  path: string
  message: string
}

export type AiVaultTranscriptSearchResult = {
  matches: AiVaultTranscriptSearchMatch[]
  issues: AiVaultTranscriptSearchIssue[]
  /** True when at least one request was dropped by a bound (never searched). */
  truncated: boolean
}

export function isAiVaultTranscriptSearchQueryTooLarge(
  query: string,
  maxBytes = AI_VAULT_TRANSCRIPT_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

/** Clamps + dedupes a raw search request into exactly what the searcher reads.
 *  Invalid entries are dropped, never rejected: the caller already holds these
 *  paths from a successful vault scan, so one bad row must not kill the rest. */
export function normalizeAiVaultTranscriptSearchArgs(args: AiVaultTranscriptSearchArgs): {
  query: string
  requests: AiVaultTranscriptSearchRequest[]
  truncated: boolean
} {
  const query = args.query.trim()
  const usable =
    query.length >= AI_VAULT_TRANSCRIPT_SEARCH_MIN_QUERY_LENGTH &&
    !isAiVaultTranscriptSearchQueryTooLarge(query)
  if (!usable) {
    return { query: '', requests: [], truncated: false }
  }
  const seen = new Set<string>()
  const requests: AiVaultTranscriptSearchRequest[] = []
  let truncated = false
  for (const raw of args.requests) {
    if (requests.length >= AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS) {
      truncated = true
      break
    }
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : ''
    if (!filePath || filePath.length > AI_VAULT_TRANSCRIPT_SEARCH_PATH_MAX_LENGTH) {
      continue
    }
    const key = `${raw.agent}\n${filePath}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined
    requests.push({ agent: raw.agent, filePath, ...(sessionId ? { sessionId } : {}) })
  }
  return { query, requests, truncated }
}

// eslint-disable-next-line no-control-regex -- intentional: strip JSONL control bytes before display.
const CONTROL_CHARS_PATTERN = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]', 'g')

/** Windowed snippet for one matched line: control bytes stripped, whitespace
 *  collapsed, and the window centered on the first hit so the term stays
 *  visible in narrow rows. */
export function extractTranscriptSearchSnippet(
  line: string,
  query: string,
  maxLength = AI_VAULT_TRANSCRIPT_SEARCH_MAX_SNIPPET_LENGTH
): string {
  // JSONL records carry control bytes and two-char escapes (\n, \t, \r);
  // strip both before display so a snippet reads as prose, not a JSON dump.
  const cleaned = line
    .replace(CONTROL_CHARS_PATTERN, ' ')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= maxLength) {
    return cleaned
  }
  const hit = cleaned.toLowerCase().indexOf(query.toLowerCase())
  if (hit === -1) {
    return `${cleaned.slice(0, maxLength)}…`
  }
  // Lead the window with a short context instead of centering the match: a
  // centered 280-char window puts the hit ~char 130, which `truncate` hides.
  const lead = Math.min(
    AI_VAULT_TRANSCRIPT_SEARCH_SNIPPET_LEAD_CHARS,
    Math.max(0, maxLength - query.length - 8)
  )
  const windowStart = Math.max(0, hit - lead)
  const windowed = cleaned.slice(windowStart, windowStart + maxLength)
  const prefix = windowStart > 0 ? '…' : ''
  const suffix = windowStart + maxLength < cleaned.length ? '…' : ''
  return `${prefix}${windowed}${suffix}`
}

/** Composite key so a renderer can join matches back to vault rows without
 *  trusting session ids to be unique across agents/hosts. */
export function aiVaultTranscriptSearchRequestKey(request: AiVaultTranscriptSearchRequest): string {
  return `${request.agent}\n${request.filePath}`
}
