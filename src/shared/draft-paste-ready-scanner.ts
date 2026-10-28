import type { DraftPasteReadySignal, TuiAgentConfig } from './tui-agent-config'
import { createOpenCodeAgentRowScanner } from './opencode-agent-row-scanner'
import { createCodexComposerReadyScanner } from './codex-composer-ready-scanner'

// Paste mode precedes composer readiness; per-agent markers avoid guessing from output silence.
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// OpenCode show-cursor follows composer mount ~2s after paste mode; do not race slow startup with a quiet timer. mimo-code shares this signal.
const DECTCEM_SHOW_CURSOR = '\x1b[?25h'
// Grok ❯ also appears in shell prompts: require alt screen. Legacy Windows > is too generic, so retain quiet/timeout fallback.
const GROK_COMPOSER_PROMPT = '❯'
// ZCode’s locale-independent round composer corner differs from square modal corners; anchor alt screen because powerline shell prompts also draw ╭.
const ZCODE_COMPOSER_BOX_CORNER = '╭'
// Why: Claude Code's prompt-input mode indicator is `figures.pointer` + NBSP; its startup menus
// (trust, theme) draw the same pointer followed by a cursor move, so the NBSP means the composer.
const CLAUDE_COMPOSER_PROMPT = '❯\u00a0'
// Why: Claude 2.1.310 turns on palette-change reports with bracketed paste and drops both on exit.
// zsh/bash never send it, so their p10k/starship `❯` prompt cannot arm the marker; fish 4+ holds it
// only while idle at its prompt, where a `❯` + NBSP glyph is unlikely.
const DECSET_COLOR_PALETTE_UPDATES = '\x1b[?2031h'
const DECRST_COLOR_PALETTE_UPDATES = '\x1b[?2031l'
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

// Signals that read the screen's structure, not one marker; a Record so none lacks its scanner.
type StructuralSignal = 'opencode-agent-row' | 'codex-composer-prompt'
const STRUCTURAL_SCANNERS: Record<
  StructuralSignal,
  () => { observe: (data: string) => { ready: boolean; readyAfterMs?: number | null } }
> = {
  'opencode-agent-row': createOpenCodeAgentRowScanner,
  'codex-composer-prompt': createCodexComposerReadyScanner
}

type SingleSignal = Exclude<DraftPasteReadySignal, StructuralSignal>

const DRAFT_PASTE_READY_SIGNALS: Record<SingleSignal, DraftPasteReadySignalSpec> = {
  'render-cursor-after-bracketed-paste': {
    markerAnchor: DECSET_BRACKETED_PASTE,
    // Shells toggle paste off before exec; later launcher cursor toggles must not count. OpenCode keeps paste enabled during boot.
    markerAnchorEnd: DECRST_BRACKETED_PASTE,
    marker: DECTCEM_SHOW_CURSOR,
    quietAnchor: null
  },
  'grok-composer-prompt': {
    markerAnchor: DECSET_ALT_SCREEN,
    // Revoke on alt-screen exit so dead agents/rc pagers cannot authorize a later shell ❯ and receive the draft.
    markerAnchorEnd: DECRST_ALT_SCREEN,
    marker: GROK_COMPOSER_PROMPT,
    // Inline/minimal grok lacks alt-screen entry; a separate 2004 quiet anchor preserves its delivery path instead of dropping drafts.
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // DSH-TUI’s animated intro needs marker/quiet behavior independently of Grok. Evidence: dsh-tui-ready-no-key.txt (2004 byte 6, 1049h byte 40, first ❯ byte 5910).
  'dsh-composer-prompt': {
    markerAnchor: DECSET_ALT_SCREEN,
    markerAnchorEnd: DECRST_ALT_SCREEN,
    marker: GROK_COMPOSER_PROMPT,
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // Why: Claude renders inline (no alt screen); the quiet window keeps the old delivery where the
  // glyph differs (Windows `figures` fallback).
  'claude-composer-prompt': {
    markerAnchor: DECSET_COLOR_PALETTE_UPDATES,
    markerAnchorEnd: DECRST_COLOR_PALETTE_UPDATES,
    marker: CLAUDE_COMPOSER_PROMPT,
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'zcode-composer-prompt': {
    markerAnchor: DECSET_ALT_SCREEN,
    markerAnchorEnd: DECRST_ALT_SCREEN,
    marker: ZCODE_COMPOSER_BOX_CORNER,
    // ZCode banner animates indefinitely; keep quiet fallback for inline builds whose alt-screen marker never arms.
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

/** Whether the signal has a composer marker, rather than only a quiet window after its anchor. */
export function draftPasteReadySignalHasMarker(readySignal: DraftPasteReadySignal): boolean {
  return !isSingleSignal(readySignal) || DRAFT_PASTE_READY_SIGNALS[readySignal].marker !== null
}

export type DraftPasteReadyScanResult = {
  /** The agent-specific ready signal fired — caller should deliver the paste now. */
  ready: boolean
  /** Caller should (re)arm the quiet-window fallback timer for this chunk. */
  armQuietTimer: boolean
  /** Ready after this many ms unless the signal fires first; null withdraws an armed one. */
  readyAfterMs?: number | null
}

export type DraftPasteReadyScanner = { observe: (data: string) => DraftPasteReadyScanResult }

/** The signal to wait for before a paste; one that Enter follows waits for the submit signal. */
export function resolvePasteReadySignal(
  agentConfig: Pick<TuiAgentConfig, 'draftPasteReadySignal' | 'submitPasteReadySignal'> | null,
  submit: boolean
): DraftPasteReadySignal {
  return (
    (submit ? agentConfig?.submitPasteReadySignal : undefined) ??
    agentConfig?.draftPasteReadySignal ??
    'render-quiet-after-bracketed-paste'
  )
}

/** Share bounded incremental PTY parsing across local/SSH/runtime waiters; callers own transport and timers. Marker ownership and quiet fallback remain independent so inline builds retain delivery without allowing shell prompts to claim agent input. */
export function createDraftPasteReadyScanner(
  readySignal: DraftPasteReadySignal
): DraftPasteReadyScanner {
  if (isSingleSignal(readySignal)) {
    return createSingleSignalScanner(readySignal)
  }
  const scanner = STRUCTURAL_SCANNERS[readySignal]()
  return {
    observe: (data) => ({ ...scanner.observe(data), armQuietTimer: false })
  }
}

function isSingleSignal(signal: DraftPasteReadySignal): signal is SingleSignal {
  return !(signal in STRUCTURAL_SCANNERS)
}

function createSingleSignalScanner(readySignal: SingleSignal): {
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

  /** Track revocable anchors in stream order so markers count only while the mode is held; exit revokes and re-entry re-arms. */
  const scanRevocableAnchorSegments = (
    window: string,
    carriedLength: number,
    anchor: string,
    end: string
  ): boolean => {
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
      // Carry rejoins anchors only; replaying it into postAnchorRecent could fabricate a marker at the duplicated seam.
      const segmentStart = Math.max(cursor, carriedLength)
      const segment =
        leaveIndex === -1 ? window.slice(segmentStart) : window.slice(segmentStart, leaveIndex)
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
          // Carry only split-anchor bytes so prior output cannot create a second enter/leave transition.
          const carriedLength = anchorCarry.length
          const window = anchorCarry + data
          anchorCarry = window.slice(-ANCHOR_CARRY_CHARS)
          if (scanRevocableAnchorSegments(window, carriedLength, markerAnchor, markerAnchorEnd)) {
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
      // No quiet anchor for cursor/Codex signals: OpenCode startup silence can last ~3.9s before mount. Wait for markers within caller timeout/process-ownership fallback.
      return { ready: false, armQuietTimer: sawQuietAnchor }
    }
  }
}
