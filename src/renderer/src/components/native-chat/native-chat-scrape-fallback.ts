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
// Moved to src/shared so non-renderer (and shared) consumers — the startup-notice reader —
// can use it too; re-exported here so this file's existing importers are unaffected.
import { stripScrollbackAnsi } from '../../../../shared/terminal-ansi-strip'

export { stripScrollbackAnsi } from '../../../../shared/terminal-ansi-strip'

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
