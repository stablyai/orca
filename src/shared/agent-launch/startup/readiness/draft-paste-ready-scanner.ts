// OpenCode show-cursor follows composer mount ~2s after paste mode; mimo-code shares this signal.
import { CURSOR_SHOW_SEQUENCE as DECTCEM_SHOW_CURSOR } from '../../../terminal/protocol/escape/terminal-cursor-restore'
import type { DraftPasteReadySignal, TuiAgentConfig } from '../../catalog/tui-agent-config-types'
import { createOpenCodeAgentRowScanner } from './opencode-agent-row-scanner'
import { createCodexComposerReadyScanner } from './codex-composer-ready-scanner'

// Paste mode precedes composer readiness; per-agent markers avoid guessing from output silence.
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// Grok ❯ also appears in shell prompts: require alt screen. Legacy Windows > is too generic, so retain quiet/timeout fallback.
const GROK_COMPOSER_PROMPT = '❯'
// ZCode’s locale-independent round composer corner differs from square modal corners; anchor alt screen because powerline shell prompts also draw ╭.
const ZCODE_COMPOSER_BOX_CORNER = '╭'
// The npm zcode-app-cli redistribution of the ZCode Desktop runtime renders inline instead of taking the alternate
// screen: it clears the pane and the scrollback — which a shell prompt never touches — then draws the same round
// composer corner. Evidence: zcode-app-cli 3.17.2-45 and 3.18.2-47 (see zcode-app-cli-composer-ready.txt).
const ZCODE_INLINE_SCREEN_TAKEOVER = '\x1b[2J\x1b[H\x1b[3J'
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
const DECSET_ALT_SCREEN = '\x1b[?1049h'
const DECRST_ALT_SCREEN = '\x1b[?1049l'

/** A takeover that arms `marker`: its bytes enter the takeover and, for modes the agent can leave, its bytes revoke it. */
type MarkerAnchorVariant = {
  /** Bytes that must precede `marker` for it to count. */
  enter: string
  /** Bytes that revoke `enter` again, or null when the takeover is sticky until the stream ends. */
  exit: string | null
}

type DraftPasteReadySignalSpec = {
  /** Takeover variants that arm `marker`, tried in order; the first to arm owns the marker until its exit revokes it. Null when there is no marker. */
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
      // The official CLI takes the alternate screen.
      { enter: DECSET_ALT_SCREEN, exit: DECRST_ALT_SCREEN },
      // zcode-app-cli renders inline and takes over with the scrollback-wiping clear instead; sticky because
      // exiting the agent revokes nothing the pane would re-arm for a shell.
      { enter: ZCODE_INLINE_SCREEN_TAKEOVER, exit: null }
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
  'render-quiet-after-bracketed-paste': {
    markerAnchors: null,
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
  let sawQuietAnchor = false

  const {
    markerAnchors,
    marker: signalMarker,
    quietAnchor
  } = DRAFT_PASTE_READY_SIGNALS[readySignal]

  /** Per-variant anchor memory: the mode state, the marker search window it owns, and its split-anchor carry. */
  type AnchorScanState = {
    sawMarkerAnchor: boolean
    postAnchorRecent: string
    anchorCarry: string
  }
  const anchorStates: readonly AnchorScanState[] | null =
    markerAnchors !== null
      ? markerAnchors.map(() => ({
          sawMarkerAnchor: false,
          postAnchorRecent: '',
          anchorCarry: ''
        }))
      : null

  /** Track one variant's revocable anchor in stream order so markers count only while the mode is held; exit revokes and re-entry re-arms. */
  const scanRevocableAnchorSegments = (
    state: AnchorScanState,
    window: string,
    carriedLength: number,
    anchor: string,
    end: string,
    marker: string | RegExp
  ): boolean => {
    let cursor = 0
    while (cursor < window.length) {
      if (!state.sawMarkerAnchor) {
        const enterIndex = window.indexOf(anchor, cursor)
        if (enterIndex === -1) {
          return false
        }
        state.sawMarkerAnchor = true
        state.postAnchorRecent = ''
        cursor = enterIndex + anchor.length
        continue
      }
      const leaveIndex = window.indexOf(end, cursor)
      // Carry rejoins anchors only; replaying it into postAnchorRecent could fabricate a marker at the duplicated seam.
      const segmentStart = Math.max(cursor, carriedLength)
      const segment =
        leaveIndex === -1 ? window.slice(segmentStart) : window.slice(segmentStart, leaveIndex)
      if (containsMarker(state.postAnchorRecent + segment, marker)) {
        return true
      }
      if (leaveIndex === -1) {
        state.postAnchorRecent = (state.postAnchorRecent + segment).slice(-512)
        return false
      }
      state.sawMarkerAnchor = false
      state.postAnchorRecent = ''
      cursor = leaveIndex + end.length
    }
    return false
  }

  /** One variant's verdict on this chunk; sticky takeovers arm once and never revoke. */
  const scanAnchorVariant = (
    state: AnchorScanState,
    variant: { enter: string; exit: string | null },
    data: string,
    combined: string,
    marker: string | RegExp
  ): boolean => {
    if (variant.exit !== null) {
      // Carry only split-anchor bytes so prior output cannot create a second enter/leave transition.
      const carriedLength = state.anchorCarry.length
      const window = state.anchorCarry + data
      state.anchorCarry = window.slice(-ANCHOR_CARRY_CHARS)
      return scanRevocableAnchorSegments(
        state,
        window,
        carriedLength,
        variant.enter,
        variant.exit,
        marker
      )
    }
    if (!state.sawMarkerAnchor) {
      const anchorIndex = combined.indexOf(variant.enter)
      if (anchorIndex === -1) {
        return false
      }
      state.sawMarkerAnchor = true
      const postAnchorChunk = combined.slice(anchorIndex + variant.enter.length)
      if (containsMarker(postAnchorChunk, marker)) {
        return true
      }
      state.postAnchorRecent = postAnchorChunk.slice(-512)
      return false
    }
    if (containsMarker(state.postAnchorRecent + data, marker)) {
      return true
    }
    state.postAnchorRecent = (state.postAnchorRecent + data).slice(-512)
    return false
  }

  return {
    observe(data: string): DraftPasteReadyScanResult {
      const combined = recent + data
      recent = combined.slice(-512)
      if (!sawQuietAnchor && quietAnchor !== null && combined.includes(quietAnchor)) {
        sawQuietAnchor = true
      }
      if (signalMarker !== null && anchorStates !== null && markerAnchors !== null) {
        for (let index = 0; index < markerAnchors.length; index += 1) {
          if (
            scanAnchorVariant(
              anchorStates[index],
              markerAnchors[index],
              data,
              combined,
              signalMarker
            )
          ) {
            return { ready: true, armQuietTimer: false }
          }
        }
      }
      // No quiet anchor for cursor/Codex signals: OpenCode startup silence can last ~3.9s before mount. Wait for markers within caller timeout/process-ownership fallback.
      return { ready: false, armQuietTimer: sawQuietAnchor }
    }
  }
}

function containsMarker(text: string, marker: string | RegExp): boolean {
  return typeof marker === 'string' ? text.includes(marker) : marker.test(text)
}
