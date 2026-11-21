// OpenCode show-cursor follows composer mount ~2s after paste mode; mimo-code shares this signal.
import { CURSOR_SHOW_SEQUENCE as DECTCEM_SHOW_CURSOR } from '../../../terminal/protocol/escape/terminal-cursor-restore'
import {
  SYNCHRONIZED_OUTPUT_END_SEQUENCE,
  SYNCHRONIZED_OUTPUT_START_SEQUENCE
} from '../../../terminal/protocol/escape/terminal-synchronized-output-scan'
import type { DraftPasteReadySignal, TuiAgentConfig } from '../../catalog/tui-agent-config-types'
import { createOpenCodeAgentRowScanner } from './opencode-agent-row-scanner'
import { createCodexComposerReadyScanner } from './codex-composer-ready-scanner'

// Paste mode precedes composer readiness; per-agent markers avoid guessing from output silence.
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// Grok ❯ also appears in shell prompts: require alt screen. Legacy Windows > is too generic, so retain quiet/timeout fallback.
const GROK_COMPOSER_PROMPT = '❯'
// ZCode’s round corner (the official composer's; npm zcode-app-cli's header card, drawn in the composer's frame) differs from
// square modal corners; anchor a screen takeover because powerline shell prompts also draw ╭.
const ZCODE_COMPOSER_BOX_CORNER = '╭'
// npm zcode-app-cli renders inline: one synchronized frame erases the screen, then paints its ╭ header card and
// composer. Shells and clear(1) never open such a frame. Evidence: zcode-app-cli-composer-ready.txt (3.18.2-47).
const ZCODE_INLINE_FRAME_START = `${SYNCHRONIZED_OUTPUT_START_SEQUENCE}\x1b[2J`
// Why: Claude Code's prompt-input mode indicator is `figures.pointer` + NBSP; its startup menus
// (trust, theme) draw the same pointer followed by a cursor move, so the NBSP means the composer.
const CLAUDE_COMPOSER_PROMPT = '❯\u00a0'
// Why: Claude 2.1.310 turns on palette-change reports with bracketed paste and drops both on exit.
// zsh/bash never send it, so their p10k/starship `❯` prompt cannot arm the marker; fish 4+ holds it
// only while idle at its prompt, where a `❯` + NBSP glyph is unlikely.
const DECSET_COLOR_PALETTE_UPDATES = '\x1b[?2031h'
const DECRST_COLOR_PALETTE_UPDATES = '\x1b[?2031l'
const SGR_RUN = '(?:\\x1b\\[[0-9;:]*m)*'
// agy's hint row, or its rule / `>` / rule composer rows, which a custom statusLine keeps after replacing the hint (#38930).
const ANTIGRAVITY_COMPOSER_READY = new RegExp(
  `\\? for shortcuts|─{8}${SGR_RUN}\\r?\\n${SGR_RUN}>(?:\\s+[A-Za-z][A-Za-z-]*\\s+mode:[^\\n]*)?${SGR_RUN}\\r?\\n${SGR_RUN}─{8}`
)
// Copilot's composer row: a rule then `❯` at column 1. Its trust menu draws `❯ 1. Yes` inside a box, never after a rule row.
// Evidence: Copilot CLI 1.0.107 draws this at ~1.2-2.4s, then animates its loading spinner and mascot past 4s.
const COPILOT_COMPOSER_READY = new RegExp(`─{8}${SGR_RUN}\\r*\\n${SGR_RUN}❯`)
// `ouro chat` reports idle over OSC 7501 once its composer takes input, and clears its row on exit. Its agent
// picker runs before the chat and reports nothing, and a shell never writes 7501, so the paste cannot answer the picker.
const OURO_STATUS_REPORT = '\x1b]7501;'
const OURO_STATUS_CLEAR = '\x1b]7501;state=clear'
const OURO_COMPOSER_READY = 'state=idle:app=ouro'
const DECSET_ALT_SCREEN = '\x1b[?1049h'
const DECRST_ALT_SCREEN = '\x1b[?1049l'

/** A takeover that arms `marker` from `enter` until `exit`; re-entry re-arms. */
type MarkerAnchorVariant = { enter: string; exit: string }

/** Per-variant memory: whether its takeover holds, the marker window it owns, and its split-anchor carry. */
type AnchorScanState = MarkerAnchorVariant & {
  marker: string | RegExp
  /** Longest anchor minus one: rejoins a split anchor; a shorter exit fits only while disarmed, where it is ignored. */
  carryChars: number
  sawMarkerAnchor: boolean
  postAnchorRecent: string
  anchorCarry: string
}

type DraftPasteReadySignalSpec = {
  /** Takeovers that each arm `marker` independently; null when there is no marker. */
  markerAnchors: readonly MarkerAnchorVariant[] | null
  /** Composer-ready marker, or null for signals that only use the quiet window. */
  marker: string | RegExp | null
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
    markerAnchors: [
      // Shells toggle paste off before exec; later launcher cursor toggles must not count. OpenCode keeps paste enabled during boot.
      { enter: DECSET_BRACKETED_PASTE, exit: DECRST_BRACKETED_PASTE }
    ],
    marker: DECTCEM_SHOW_CURSOR,
    quietAnchor: null
  },
  'grok-composer-prompt': {
    markerAnchors: [
      // Revoke on alt-screen exit so dead agents/rc pagers cannot authorize a later shell ❯ and receive the draft.
      { enter: DECSET_ALT_SCREEN, exit: DECRST_ALT_SCREEN }
    ],
    marker: GROK_COMPOSER_PROMPT,
    // Inline/minimal grok lacks alt-screen entry; a separate 2004 quiet anchor preserves its delivery path instead of dropping drafts.
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // DSH-TUI’s animated intro needs marker/quiet behavior independently of Grok. Evidence: dsh-tui-ready-no-key.txt (2004 byte 6, 1049h byte 40, first ❯ byte 5910).
  'dsh-composer-prompt': {
    markerAnchors: [{ enter: DECSET_ALT_SCREEN, exit: DECRST_ALT_SCREEN }],
    marker: GROK_COMPOSER_PROMPT,
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // Why: Claude renders inline (no alt screen); the quiet window keeps the old delivery where the
  // glyph differs (Windows `figures` fallback).
  'claude-composer-prompt': {
    markerAnchors: [{ enter: DECSET_COLOR_PALETTE_UPDATES, exit: DECRST_COLOR_PALETTE_UPDATES }],
    marker: CLAUDE_COMPOSER_PROMPT,
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'zcode-composer-prompt': {
    markerAnchors: [
      { enter: DECSET_ALT_SCREEN, exit: DECRST_ALT_SCREEN },
      // A wipe holds no mode, so only the frame it opens may draw ╭.
      { enter: ZCODE_INLINE_FRAME_START, exit: SYNCHRONIZED_OUTPUT_END_SEQUENCE }
    ],
    marker: ZCODE_COMPOSER_BOX_CORNER,
    // ZCode banner animates indefinitely; keep quiet fallback for inline builds whose alt-screen marker never arms.
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // agy's composer; its trust dialog, sign-in menu and a shell prompt never draw it. No quiet fallback:
  // the shell prompt's 2004h would arm it before agy starts. Evidence: agy 1.2.14 and 1.5.2 startups.
  'antigravity-composer-prompt': {
    markerAnchors: [{ enter: DECSET_BRACKETED_PASTE, exit: DECRST_BRACKETED_PASTE }],
    marker: ANTIGRAVITY_COMPOSER_READY,
    quietAnchor: null
  },
  // Its loading spinner and mascot keep the quiet window from settling for seconds after the composer accepts paste.
  'copilot-composer-prompt': {
    markerAnchors: [{ enter: DECSET_ALT_SCREEN, exit: DECRST_ALT_SCREEN }],
    marker: COPILOT_COMPOSER_READY,
    // Keep the quiet fallback for a build or platform whose composer row differs.
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  // No quiet fallback: a quiet window can settle while the agent picker waits, and the paste would answer it.
  'ouro-composer-prompt': {
    markerAnchors: [{ enter: OURO_STATUS_REPORT, exit: OURO_STATUS_CLEAR }],
    marker: OURO_COMPOSER_READY,
    quietAnchor: null
  },
  'render-quiet-after-bracketed-paste': {
    markerAnchors: null,
    marker: null,
    quietAnchor: DECSET_BRACKETED_PASTE
  }
}

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
  let quietCarry = ''
  let sawQuietAnchor = false

  const {
    markerAnchors,
    marker: signalMarker,
    quietAnchor
  } = DRAFT_PASTE_READY_SIGNALS[readySignal]

  const anchorStates: AnchorScanState[] =
    signalMarker === null
      ? []
      : (markerAnchors ?? []).map((variant) => ({
          ...variant,
          marker: signalMarker,
          carryChars: Math.max(variant.enter.length, variant.exit.length) - 1,
          sawMarkerAnchor: false,
          postAnchorRecent: '',
          anchorCarry: ''
        }))

  /** Track one variant's anchor in stream order so markers count only while it holds; exit revokes and re-entry re-arms. */
  const scanAnchorVariant = (state: AnchorScanState, data: string): boolean => {
    // Carry only split-anchor bytes so prior output cannot create a second enter/leave transition.
    const carriedLength = state.anchorCarry.length
    const window = state.anchorCarry + data
    state.anchorCarry = window.slice(-state.carryChars)
    let cursor = 0
    // A hit still reads the chunk's later exits, so a vetoed ready cannot outlive its takeover.
    let fired = false
    while (cursor < window.length) {
      if (!state.sawMarkerAnchor) {
        const enterIndex = window.indexOf(state.enter, cursor)
        if (enterIndex === -1) {
          return fired
        }
        state.sawMarkerAnchor = true
        state.postAnchorRecent = ''
        cursor = enterIndex + state.enter.length
        continue
      }
      const leaveIndex = window.indexOf(state.exit, cursor)
      // Carry rejoins anchors only; replaying it into postAnchorRecent could fabricate a marker at the duplicated seam.
      const segmentStart = Math.max(cursor, carriedLength)
      const segment =
        leaveIndex === -1 ? window.slice(segmentStart) : window.slice(segmentStart, leaveIndex)
      const hit = containsMarker(state.postAnchorRecent + segment, state.marker)
      fired ||= hit
      if (leaveIndex === -1) {
        // A hit is not kept, so a vetoed ready waits for a new marker.
        if (!hit) {
          state.postAnchorRecent = (state.postAnchorRecent + segment).slice(-512)
        }
        return fired
      }
      state.sawMarkerAnchor = false
      state.postAnchorRecent = ''
      cursor = leaveIndex + state.exit.length
    }
    return fired
  }

  return {
    observe(data: string): DraftPasteReadyScanResult {
      if (!sawQuietAnchor && quietAnchor !== null) {
        const window = quietCarry + data
        sawQuietAnchor = window.includes(quietAnchor)
        quietCarry = window.slice(-(quietAnchor.length - 1))
      }
      // Every variant sees every chunk, so one firing cannot leave another's exit unread.
      let ready = false
      for (const state of anchorStates) {
        ready = scanAnchorVariant(state, data) || ready
      }
      if (ready) {
        return { ready: true, armQuietTimer: false }
      }
      // No quiet anchor for cursor/Codex signals: OpenCode startup silence can last ~3.9s before mount. Wait for markers within caller timeout/process-ownership fallback.
      return { ready: false, armQuietTimer: sawQuietAnchor }
    }
  }
}

function containsMarker(text: string, marker: string | RegExp): boolean {
  return typeof marker === 'string' ? text.includes(marker) : marker.test(text)
}
