// Why: crush (charmbracelet/crush) runs an interactive TUI even in client-server mode.
// Orca launches crush with `CRUSH_CLIENT_SERVER=1` and a per-pane custom `--host`
// unix socket so each pane owns a private crush server + SSE stream. This module
// is the pure, Electron-free shape of that stream: payload types, socket path
// derivation, and a stateful SSE line parser. The normalizer (agent-hook-listener)
// and the main-process SSE client (crush-sse-bridge) both depend on these.

import { createHash } from 'node:crypto'

export const CRUSH_ORCA_SOCKET_PREFIX = 'crush-orca-'
const CRUSH_ORCA_SOCKET_SUFFIX = '.sock'
// Why: macOS sun_path is 104 bytes incl. NUL, Linux 108. Use the lower bound so
// the bound socket path fits on both platforms; longer paths fail bind(2)/connect(2).
const CRUSH_ORCA_SOCKET_PATH_MAX = 103

/** Derive the per-pane unix socket filename Orca instructs crush to bind.
 *  Why: per-pane socket → one crush server per pane → SSE attribution is trivial
 *  (events on socket X belong to pane X), sidestepping crush's single-global-socket
 *  workspace multiplexing which would otherwise need session_id→paneKey mapping.
 *
 *  Pass `socketDir` to enable the sun_path-safe fallback: when `dir + sep + name`
 *  would exceed the platform's sockaddr_un limit, the token is replaced by a
 *  12-hex sha1 digest. Deterministic → crush's auto-spawned server (which inherits
 *  `--host`) lands on the same path Orca dials. */
export function crushOrcaSocketFileName(launchToken: string, socketDir?: string): string {
  const raw = (launchToken || 'default').replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
  const inline = `${CRUSH_ORCA_SOCKET_PREFIX}${raw}${CRUSH_ORCA_SOCKET_SUFFIX}`
  if (socketDir !== undefined) {
    const dirLen = (socketDir.endsWith('/') ? socketDir.slice(0, -1) : socketDir).length
    if (dirLen + 1 + inline.length > CRUSH_ORCA_SOCKET_PATH_MAX) {
      const digest = createHash('sha1')
        .update(launchToken || 'default')
        .digest('hex')
        .slice(0, 12)
      return `${CRUSH_ORCA_SOCKET_PREFIX}${digest}${CRUSH_ORCA_SOCKET_SUFFIX}`
    }
  }
  return inline
}

/** Full `--host` value Orca passes to crush. `unix://` scheme + absolute socket path.
 *  Empty launchToken falls back to a generic name so callers can probe without a
 *  bound pane (used only in tests). Truncates the token to a hash when the full
 *  path would exceed sun_path on the host platform. */
export function crushOrcaHostUrl(socketDir: string, launchToken: string): string {
  const fileName = crushOrcaSocketFileName(launchToken || 'default', socketDir)
  return `unix://${socketDir.endsWith('/') ? socketDir.slice(0, -1) : socketDir}/${fileName}`
}

// ─── SSE payload wire shapes (from internal/proto + internal/pubsub/events.go) ─

/** Outer SSE envelope. `type` is the pubsub PayloadType discriminator. */
export type CrushSseEnvelope = {
  type: 'message' | 'session' | 'permission_request' | 'agent_event' | 'run_complete' | string
  payload?: { type: 'created' | 'updated' | 'deleted'; payload?: unknown } | unknown
}

export type CrushContentPart =
  | { type: 'text'; data: { text: string } }
  | { type: 'reasoning'; data: { thinking: string } }
  | { type: 'tool_call'; data: { id: string; name: string; input: string; finished?: boolean } }
  | {
      type: 'tool_result'
      data: { tool_call_id: string; name: string; content: string; is_error?: boolean }
    }
  | { type: 'finish'; data: { reason: string; time: number } }
  | { type: string; data: Record<string, unknown> }

export type CrushMessage = {
  id: string
  role: 'assistant' | 'user' | 'system' | 'tool' | string
  session_id?: string
  parts?: CrushContentPart[]
  model?: string
  provider?: string
}

export type CrushPermissionRequest = {
  id: string
  session_id?: string
  tool_call_id?: string
  tool_name: string
  description?: string
  action?: string
  params?: unknown
  path?: string
}

export type CrushRunComplete = {
  session_id?: string
  run_id?: string
  message_id?: string
  text?: string
  error?: string
  cancelled?: boolean
}

export type CrushAgentEvent = {
  type: 'response' | 'error' | 'summarize' | string
  session_id?: string
  run_id?: string
  message?: CrushMessage
  error?: string
  progress?: string
  done?: boolean
}

/** Encode SSE payload type + (for `message`) role into a stable hook-event-name
 *  Orca's normalizer can switch on. Why: `message` events with role=user act as a
 *  new-turn boundary (reset tool cache) while role=assistant/tool are working
 *  updates; the existing `isNewTurnEvent(source, eventName)` signature takes only
 *  an eventName, so we encode role = `message:user` / `message:assistant`. */
export function crushHookEventName(envelope: CrushSseEnvelope): string | null {
  switch (envelope.type) {
    case 'message': {
      const inner = envelope.payload as { payload?: CrushMessage } | undefined
      const msg = inner?.payload
      const role = typeof msg === 'object' && msg !== null ? msg.role : undefined
      return role === 'user'
        ? 'message:user'
        : role === 'assistant'
          ? 'message:assistant'
          : 'message'
    }
    case 'permission_request':
    case 'run_complete':
    case 'agent_event':
      return envelope.type
    default:
      return null
  }
}

/** Pull the event-type-specific inner payload out of the SSE envelope. */
export function crushHookPayload(envelope: CrushSseEnvelope): Record<string, unknown> {
  const inner = (envelope.payload as { payload?: unknown } | undefined)?.payload
  if (inner && typeof inner === 'object' && inner !== null) {
    return inner as Record<string, unknown>
  }
  return {}
}

// ─── SSE line parser (stateful, chunk-boundary tolerant) ──────────────────────

export type ParsedSseEvent = {
  /** Concatenated `data:` lines for one event. */
  data: string
}

/** Parse an SSE byte stream incrementally. Returns events fully received this
 *  call plus the leftover buffer to carry into the next call. SSE events are
 *  delimited by a blank line (`\n\n`); within an event, only `data:` lines are
 *  consumed (per spec, leading single space after `data:` is stripped). */
export function parseCrushSseChunk(
  buffer: string,
  incoming: string
): {
  events: ParsedSseEvent[]
  rest: string
} {
  const combined = buffer + incoming
  const events: ParsedSseEvent[] = []
  let cursor = 0
  while (cursor < combined.length) {
    const sep = combined.indexOf('\n\n', cursor)
    if (sep === -1) {
      break
    }
    const rawEvent = combined.slice(cursor, sep)
    cursor = sep + 2
    const dataLines: string[] = []
    for (const line of rawEvent.split('\n')) {
      if (!line.startsWith('data:')) {
        continue
      }
      const value = line.slice('data:'.length)
      // Why: SSE spec strips a single leading space after the colon.
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    if (dataLines.length > 0) {
      events.push({ data: dataLines.join('\n') })
    }
  }
  return { events, rest: combined.slice(cursor) }
}

/** Parse one SSE event's data as a crush envelope. Returns null on malformed JSON. */
export function parseCrushSseEvent(event: ParsedSseEvent): CrushSseEnvelope | null {
  try {
    return JSON.parse(event.data) as CrushSseEnvelope
  } catch {
    return null
  }
}
