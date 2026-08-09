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
// Why: grok's composer prompt glyph (U+276F), rendered once the input box
// mounts. It is also the default glyph of popular shell prompts (starship,
// pure), so it is anchored on the alternate-screen switch below — the shell
// prompt that precedes the launch command is always in the normal buffer.
// grok swaps it for `> ` on legacy Windows consoles, which is too generic to
// match; those fall back to the quiet window and the caller's hard timeout.
const GROK_COMPOSER_PROMPT = '❯'
const DECSET_ALT_SCREEN = '\x1b[?1049h'

type DraftPasteReadySignalSpec = {
  /** Bytes that must be seen before `marker` counts; everything earlier is ignored. */
  anchor: string
  /** Composer-ready marker, or null for signals that only use the quiet window. */
  marker: string | null
  /** Whether the quiet window is armed as a fallback once the anchor is seen. */
  quietFallback: boolean
}

const DRAFT_PASTE_READY_SIGNALS: Record<DraftPasteReadySignal, DraftPasteReadySignalSpec> = {
  'codex-composer-prompt': {
    anchor: DECSET_BRACKETED_PASTE,
    marker: CODEX_COMPOSER_PROMPT,
    quietFallback: false
  },
  'render-cursor-after-bracketed-paste': {
    anchor: DECSET_BRACKETED_PASTE,
    marker: DECTCEM_SHOW_CURSOR,
    quietFallback: false
  },
  'grok-composer-prompt': {
    anchor: DECSET_ALT_SCREEN,
    marker: GROK_COMPOSER_PROMPT,
    // Why: grok renders differentially, so the composer glyph is painted once
    // and a scanner that attached after that frame would never see it. The
    // quiet window can't pre-empt the marker here — grok animates its startup
    // logo continuously until well past composer mount.
    quietFallback: true
  },
  'render-quiet-after-bracketed-paste': {
    anchor: DECSET_BRACKETED_PASTE,
    marker: null,
    quietFallback: true
  }
}

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
 *   - `grok-composer-prompt`: ready when grok's `❯` glyph renders after the
 *     alternate-screen switch (`\x1b[?1049h`). grok shimmers its startup logo
 *     until the session opens, so the quiet window alone never settles and the
 *     draft waited out the full hard timeout (~8s). The anchor is the alt-screen
 *     switch, not DECSET 2004, because the shell that runs the launch command
 *     emits 2004 too and its own prompt may be `❯` (starship, pure) — anchoring
 *     there could paste into the shell. Keeps the quiet window as a fallback.
 *   - `render-quiet-after-bracketed-paste` (default): no signal marker; arms the
 *     quiet window once DECSET 2004 is seen.
 *
 * A 512-byte ring (`recent` / `postAnchorRecent`) covers escape sequences
 * split across chunk boundaries without retaining terminal scrollback.
 */
export function createDraftPasteReadyScanner(readySignal: DraftPasteReadySignal): {
  observe: (data: string) => DraftPasteReadyScanResult
} {
  let recent = ''
  let postAnchorRecent = ''
  let sawAnchor = false

  const { anchor, marker: signalMarker, quietFallback } = DRAFT_PASTE_READY_SIGNALS[readySignal]

  return {
    observe(data: string): DraftPasteReadyScanResult {
      const combined = recent + data
      recent = combined.slice(-512)
      if (!sawAnchor) {
        const anchorIndex = combined.indexOf(anchor)
        if (anchorIndex === -1) {
          return { ready: false, armQuietTimer: false }
        }
        sawAnchor = true
        const postAnchorChunk = combined.slice(anchorIndex + anchor.length)
        if (signalMarker !== null && postAnchorChunk.includes(signalMarker)) {
          return { ready: true, armQuietTimer: false }
        }
        postAnchorRecent = postAnchorChunk.slice(-512)
      } else {
        if (
          signalMarker !== null &&
          (data.includes(signalMarker) || (postAnchorRecent + data).includes(signalMarker))
        ) {
          return { ready: true, armQuietTimer: false }
        }
        postAnchorRecent = (postAnchorRecent + data).slice(-512)
      }
      // Why: the Codex glyph and opencode show-cursor signals must NOT arm the
      // quiet window. opencode goes silent for ~1.5-2s between enabling
      // bracketed paste and mounting its composer, so a quiet window would fire
      // during that gap — before the composer exists — and pre-empt the marker.
      // Those signals wait for their marker, bounded only by the caller's hard
      // timeout (and the caller's best-effort process-ownership paste after it).
      return { ready: false, armQuietTimer: quietFallback && sawAnchor }
    }
  }
}
