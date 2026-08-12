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
const DECRST_ALT_SCREEN = '\x1b[?1049l'

type DraftPasteReadySignalSpec = {
  /** Bytes that must precede `marker` for it to count; null when there is no marker. */
  markerAnchor: string | null
  /** Bytes that revoke `markerAnchor` again, for anchors that describe a mode the agent can leave. */
  markerAnchorEnd: string | null
  /** Composer-ready marker, or null for signals that only use the quiet window. */
  marker: string | null
  /** Bytes that arm the quiet-window fallback, or null when the signal has none. */
  quietAnchor: string | null
}

const DRAFT_PASTE_READY_SIGNALS: Record<DraftPasteReadySignal, DraftPasteReadySignalSpec> = {
  'codex-composer-prompt': {
    markerAnchor: DECSET_BRACKETED_PASTE,
    markerAnchorEnd: null,
    marker: CODEX_COMPOSER_PROMPT,
    quietAnchor: null
  },
  'render-cursor-after-bracketed-paste': {
    markerAnchor: DECSET_BRACKETED_PASTE,
    markerAnchorEnd: null,
    marker: DECTCEM_SHOW_CURSOR,
    quietAnchor: null
  },
  'grok-composer-prompt': {
    markerAnchor: DECSET_ALT_SCREEN,
    // Why: leaving the alternate screen hands the terminal back to the shell, whose
    // prompt may be `❯`. Without revoking the anchor, a grok that entered the alt
    // screen and then died — or a pager run from the user's shell rc before grok even
    // launched — would leave the glyph armed forever and paste into the shell.
    markerAnchorEnd: DECRST_ALT_SCREEN,
    marker: GROK_COMPOSER_PROMPT,
    // Why: the quiet window stays on DECSET 2004, independent of the alt-screen
    // marker anchor. grok can be configured to render inline (`--no-alt-screen`,
    // `[ui] screen_mode = "minimal"`), where 1049h never arrives — anchoring the
    // fallback there too would leave the draft with no delivery path at all, and
    // the main-process caller drops the draft when readiness never resolves.
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'render-quiet-after-bracketed-paste': {
    markerAnchor: null,
    markerAnchorEnd: null,
    marker: null,
    quietAnchor: DECSET_BRACKETED_PASTE
  }
}

/** Longest anchor sequence minus one — the carry needed to rejoin one split across chunks. */
const ANCHOR_CARRY_CHARS = 7

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
 *     draft waited out the full hard timeout (~8s). The glyph is anchored on the
 *     alt-screen switch rather than DECSET 2004 because the shell that runs the
 *     launch command emits 2004 too and its own prompt may be `❯` (starship,
 *     pure) — anchoring there could paste into the shell. This is the only
 *     signal with both a marker and a quiet window, and they use DIFFERENT
 *     anchors: grok can render inline (`--no-alt-screen`, `[ui] screen_mode =
 *     "minimal"`) and on legacy Windows consoles draws `> ` instead of `❯`, so
 *     the marker is best-effort and the 2004-anchored quiet window is the floor
 *     that keeps those launches on the pre-existing delivery path. The alt-screen
 *     anchor is revoked on `\x1b[?1049l`: leaving it hands the terminal back to
 *     the shell, so a glyph after that is the shell's prompt, not grok's composer.
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
  let anchorCarry = ''
  let sawMarkerAnchor = false
  let sawQuietAnchor = false

  const {
    markerAnchor,
    markerAnchorEnd,
    marker: signalMarker,
    quietAnchor
  } = DRAFT_PASTE_READY_SIGNALS[readySignal]

  /**
   * Why: an anchor the agent can leave (the alternate screen) has to be tracked in
   * stream ORDER, not as "seen once". Walk the chunk segment by segment so a marker
   * only counts while the anchor is actually held, and re-entering re-arms it.
   * Only reachable for signals that define `markerAnchorEnd`.
   */
  const scanRevocableAnchorSegments = (window: string, anchor: string, end: string): boolean => {
    let cursor = 0
    while (cursor < window.length) {
      if (!sawMarkerAnchor) {
        const enterIndex = window.indexOf(anchor, cursor)
        if (enterIndex === -1) {
          return false
        }
        sawMarkerAnchor = true
        postAnchorRecent = ''
        cursor = enterIndex + anchor.length
        continue
      }
      const leaveIndex = window.indexOf(end, cursor)
      const segment = leaveIndex === -1 ? window.slice(cursor) : window.slice(cursor, leaveIndex)
      if ((postAnchorRecent + segment).includes(signalMarker ?? '')) {
        return true
      }
      if (leaveIndex === -1) {
        postAnchorRecent = (postAnchorRecent + segment).slice(-512)
        return false
      }
      sawMarkerAnchor = false
      postAnchorRecent = ''
      cursor = leaveIndex + end.length
    }
    return false
  }

  return {
    observe(data: string): DraftPasteReadyScanResult {
      const combined = recent + data
      recent = combined.slice(-512)
      if (!sawQuietAnchor && quietAnchor !== null && combined.includes(quietAnchor)) {
        sawQuietAnchor = true
      }
      if (signalMarker !== null && markerAnchor !== null) {
        if (markerAnchorEnd !== null) {
          // Why: carry only the bytes an anchor could straddle, so already-scanned
          // output is never re-walked into a second enter/leave transition.
          const window = anchorCarry + data
          anchorCarry = window.slice(-ANCHOR_CARRY_CHARS)
          if (scanRevocableAnchorSegments(window, markerAnchor, markerAnchorEnd)) {
            return { ready: true, armQuietTimer: false }
          }
        } else if (!sawMarkerAnchor) {
          const anchorIndex = combined.indexOf(markerAnchor)
          if (anchorIndex !== -1) {
            sawMarkerAnchor = true
            const postAnchorChunk = combined.slice(anchorIndex + markerAnchor.length)
            if (postAnchorChunk.includes(signalMarker)) {
              return { ready: true, armQuietTimer: false }
            }
            postAnchorRecent = postAnchorChunk.slice(-512)
          }
        } else {
          if (data.includes(signalMarker) || (postAnchorRecent + data).includes(signalMarker)) {
            return { ready: true, armQuietTimer: false }
          }
          postAnchorRecent = (postAnchorRecent + data).slice(-512)
        }
      }
      // Why: the Codex glyph and opencode show-cursor signals must NOT arm the
      // quiet window (they carry no quiet anchor). opencode goes silent for
      // ~1.5-2s between enabling bracketed paste and mounting its composer, so a
      // quiet window would fire during that gap — before the composer exists —
      // and pre-empt the marker. Those signals wait for their marker, bounded
      // only by the caller's hard timeout (and its best-effort
      // process-ownership paste after that).
      return { ready: false, armQuietTimer: sawQuietAnchor }
    }
  }
}
