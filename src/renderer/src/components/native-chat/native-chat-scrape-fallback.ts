// Degraded conversation source for panes with no on-disk transcript and no live
// agent-hook session id. We have nothing structured to work with — only the raw
// terminal scrollback — so we strip ANSI and best-effort segment it into coarse
// user/assistant turns. This is intentionally approximate: no per-agent TUI
// parsing happens here, and every produced message is marked `source:'scrape'`
// so the assembler ranks it below transcript/hook copies of the same turn. See
// docs/plans/2026-06-17-001-feat-native-chat-view-plan.md (U6).

import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession
} from '../../../../shared/native-chat-types'
import { assembleNativeChatSession } from './native-chat-session-assembler'

// Why: replicate (not import) the minimal ANSI/control-sequence strip used by
// agent-session-fork-context.ts so we don't modify that file. Same three
// patterns: CSI sequences, OSC sequences, and stray single-char escapes.
const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')

function stripUnsupportedControlCharacters(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    // Drop C0 control chars except tab (9) and newline (10); keep DEL (127) out.
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue
    }
    result += char
  }
  return result
}

/** Strip ANSI/OSC escapes and normalize newlines so the raw scrollback reads as
 *  plain text. Pure; safe to reuse in tests. */
export function stripScrollbackAnsi(value: string): string {
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

// Why: a user prompt in a terminal almost always begins with a recognizable
// shell/agent prompt marker. We treat a segment whose first line starts with one
// of these as 'user'; everything else is assistant output. This is the
// documented role heuristic — coarse and deliberately conservative.
const USER_PROMPT_MARKERS = ['$', '%', '>', '#', '❯', '➜', '»']

function looksLikeUserPrompt(segment: string): boolean {
  const firstLine = segment.split('\n', 1)[0]?.trimStart() ?? ''
  if (firstLine.length === 0) {
    return false
  }
  const firstChar = firstLine[0]
  return USER_PROMPT_MARKERS.includes(firstChar)
}

/**
 * Pure: strip ANSI from raw scrollback, then segment into coarse, ordered
 * messages. Segmentation rule (intentionally approximate): split on runs of one
 * or more blank lines — these are the most reliable visual turn boundary in a
 * terminal without per-agent TUI parsing. Each non-empty segment becomes one
 * message: role is best-effort via the prompt-marker heuristic, timestamp is
 * null (scrollback carries no reliable wall-clock), source is always 'scrape',
 * and the id is derived from the segment index so it's stable across re-scrapes.
 */
export function scrapeScrollbackToMessages(rawScrollback: string): NativeChatMessage[] {
  const cleaned = stripScrollbackAnsi(rawScrollback)
  if (cleaned.trim().length === 0) {
    return []
  }

  const segments = cleaned
    .split(/\n[ \t]*\n+/)
    .map((segment) => segment.replace(/\s+$/g, '').replace(/^\n+/, ''))
    .filter((segment) => segment.trim().length > 0)

  return segments.map((segment, index) => ({
    id: `scrape-${index}`,
    role: looksLikeUserPrompt(segment) ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: segment }],
    timestamp: null,
    source: 'scrape'
  }))
}

/** A scrape-derived session plus the always-true `isApproximate` flag the UI
 *  uses to render an "approximate view" banner. Scrape sessions can never be
 *  authoritative, so the flag is structural, not conditional. */
export type ScrapeNativeChatSession = {
  session: NativeChatSession
  isApproximate: true
}

/**
 * Convenience that assembles a `NativeChatSession` from scrollback scrape.
 * Status is the assembler's derived value: 'empty' for blank scrollback,
 * 'ready' otherwise. `sessionId` is null because scrape has no provider id.
 * Reuses `assembleNativeChatSession` read-only (no edits to the assembler).
 *
 * Remote/SSH: this entry takes an already-serialized scrollback string and is
 * transport-agnostic. The caller obtains it via the runtime-appropriate API —
 * `getMainBufferSnapshot`/serializer for local panes, or the remote serialize
 * RPC (remote-runtime-terminal-multiplexer) for remote panes — so no remote
 * branch is needed inside this fallback.
 */
export function scrapeNativeChatSession(
  rawScrollback: string,
  agent: AgentType
): ScrapeNativeChatSession {
  const messages = scrapeScrollbackToMessages(rawScrollback)
  const session = assembleNativeChatSession({
    sources: { scrape: messages },
    sessionId: null,
    agent
  })
  return { session, isApproximate: true }
}
