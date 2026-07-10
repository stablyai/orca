import type { DraftPasteReadySignal } from './tui-agent-config'

// Why: agents enable bracketed paste (DECSET 2004) before their composer is
// actually mounted/focused. These markers let the scanner detect the real
// "input is ready" moment per agent instead of guessing from output silence.
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT = '›'
// Why: opencode emits the DECTCEM show-cursor only once the composer row is
// mounted and the text cursor is placed in it — a "composer ready" signal,
// analogous to Codex's prompt glyph. It fires ~2s after bracketed paste is
// enabled, so gating on it (instead of a quiet window) stops the paste from
// racing the composer mount under slow/noisy startup. mimo-code uses the same
// signal by parity; the quiet-window fallback covers any agent that differs.
const DECTCEM_SHOW_CURSOR = '\x1b[?25h'

export type DraftPasteReadyScanResult = {
  /** The agent-specific ready signal fired — caller should deliver the paste now. */
  ready: boolean
  /** Caller should (re)arm the quiet-window fallback timer for this chunk. */
  armQuietTimer: boolean
}

/**
 * Pure, incremental scanner shared by the renderer and main-process draft-paste
 * readiness waiters so the two delivery paths (desktop-local vs runtime/SSH/
 * remote) cannot drift. It only parses the PTY byte stream; timers, the PTY
 * subscription, and resolution stay with each caller because their transports
 * and return types differ.
 *
 * Per agent signal:
 *   - `codex-composer-prompt`: ready when the `›` glyph renders after DECSET
 *     2004; never arms the quiet window (`armQuietTimer` stays false).
 *   - `render-cursor-after-bracketed-paste`: ready when DECTCEM show-cursor
 *     (`\x1b[?25h`) renders after DECSET 2004. Like Codex it does NOT arm the
 *     quiet window: opencode stays silent for ~1.5-2s between enabling
 *     bracketed paste and mounting its composer, so a quiet window would fire
 *     during that gap and pre-empt the marker. opencode re-emits show-cursor on
 *     every render frame once mounted, so the marker is effectively guaranteed;
 *     the caller's hard timeout is the backstop if it never appears.
 *   - `render-quiet-after-bracketed-paste` (default): no signal marker; arms the
 *     quiet window once DECSET 2004 is seen.
 *
 * A 512-byte ring (`recent` / `postHandshakeRecent`) covers escape sequences
 * split across chunk boundaries without retaining terminal scrollback.
 */
export function createDraftPasteReadyScanner(readySignal: DraftPasteReadySignal): {
  observe: (data: string) => DraftPasteReadyScanResult
} {
  let recent = ''
  let postHandshakeRecent = ''
  let saw2004 = false

  const signalMarker =
    readySignal === 'codex-composer-prompt'
      ? CODEX_COMPOSER_PROMPT
      : readySignal === 'render-cursor-after-bracketed-paste'
        ? DECTCEM_SHOW_CURSOR
        : null

  return {
    observe(data: string): DraftPasteReadyScanResult {
      const combined = recent + data
      recent = combined.slice(-512)
      if (!saw2004) {
        const markerIndex = combined.indexOf(DECSET_BRACKETED_PASTE)
        if (markerIndex === -1) {
          return { ready: false, armQuietTimer: false }
        }
        saw2004 = true
        const postHandshakeChunk = combined.slice(markerIndex + DECSET_BRACKETED_PASTE.length)
        if (signalMarker !== null && postHandshakeChunk.includes(signalMarker)) {
          return { ready: true, armQuietTimer: false }
        }
        postHandshakeRecent = postHandshakeChunk.slice(-512)
      } else {
        if (
          signalMarker !== null &&
          (data.includes(signalMarker) || (postHandshakeRecent + data).includes(signalMarker))
        ) {
          return { ready: true, armQuietTimer: false }
        }
        postHandshakeRecent = (postHandshakeRecent + data).slice(-512)
      }
      // Why: marker-based signals (Codex glyph, opencode show-cursor) must NOT
      // arm the quiet window. opencode goes silent for ~1.5-2s between enabling
      // bracketed paste and mounting its composer, so a quiet window would fire
      // during that gap — before the composer exists — and pre-empt the marker.
      // These signals wait for their marker, bounded only by the caller's hard
      // timeout (and the caller's best-effort process-ownership paste after it).
      // Only the default signal, which has no marker, uses the quiet window.
      return { ready: false, armQuietTimer: signalMarker === null && saw2004 }
    }
  }
}
