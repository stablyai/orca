import { countAgentTuiInputLines } from './agent-tui-input-clear'
import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from './orchestration-timing-budgets'
import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'
import type { TerminalAgent } from './terminal-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'
/** Why: Claude Code can leave a prompt as editable text when paste-end and Enter arrive in the
 *  same PTY write, so the desktop's draft paste sends Enter on the next turn, this long after. */
export const AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS = 50

/** Why unknown agents keep the lead: an unidentified Claude still needs it, while known non-Claude
 *  TUIs get pre-lead bytes because Codex drops typed text that shares the paste's write (STA-8200). */
export function agentPromptTakesLeadLine(agent: TerminalAgent | null | undefined): boolean {
  return !isTuiAgent(agent) || TUI_AGENT_CONFIG[agent].pasteNeedsTypedRequest === true
}

/** OMP recognizes a submitted bracketed paste only when Enter shares its PTY write. */
export function agentPromptSubmitJoinsPasteFrame(agent: TerminalAgent | null | undefined): boolean {
  return agent === 'omp'
}

// Why: Windows ConPTY ingests pasted input linearly (first byte written -> child observes
// ESC[201~), and the cost is input ingest, not rendering -- the child repaints in ~0 ms on
// both platforms. Two real Win11 hosts, bundled ConPTY DLL, 16 KiB chunks:
//   bytes     host A    host B
//   2,000      14 ms     25 ms
//   8,000      60 ms     89 ms
//   40,000    347 ms    440 ms
//   160,000  1662 ms   1499 ms
//   320,000  3342 ms   2969 ms
// Slopes: 0.0104 ms/byte (A) and 0.0092 ms/byte (B), i.e. ~40% host-to-host spread in both
// directions. 64 B/ms is 1.5x the slower of the two slopes, so neither host -- nor a
// meaningfully slower one -- can still be ingesting when the wait ends.
const WINDOWS_CONPTY_INGEST_BYTES_PER_MS = 64
// Why: the same walk on macOS drains 320 KB in 26 ms (~12.3 KB/ms), but at those magnitudes
// the samples are noise-dominated (80 KB measured faster than 40 KB), so hold a 3x margin.
// It costs 0 ms at real prompt sizes and 4.1 s at the 16 MB terminal-input ceiling.
const DEFAULT_PASTE_INGEST_BYTES_PER_MS = 4_096
// Why: ingest only buys the child the *bytes*; it still has to attach the completed paste
// before Enter counts. Unchanged from the previous cross-platform constant -- nothing
// measured here justifies moving it, and it also absorbs the 15-25 ms fixed intercept
// both ConPTY hosts show below the linear term.
const AGENT_PROMPT_SUBMIT_SETTLE_MS = 500

/** Lower bound on when a paste of `byteLength` can have reached the child, given the
 *  ingest rate of the host that owns the pty transport (not the OS the command runs under). */
export function getTerminalPasteIngestMs(platform: NodeJS.Platform, byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return 0
  }
  return Math.ceil(
    byteLength /
      (platform === 'win32'
        ? WINDOWS_CONPTY_INGEST_BYTES_PER_MS
        : DEFAULT_PASTE_INGEST_BYTES_PER_MS)
  )
}

/** Largest paste whose host-ingest floor fits in `budgetMs`. */
export function getMaxTerminalPasteBytesForIngestMs(
  platform: NodeJS.Platform,
  budgetMs: number
): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return 0
  }
  const bytesPerMs =
    platform === 'win32' ? WINDOWS_CONPTY_INGEST_BYTES_PER_MS : DEFAULT_PASTE_INGEST_BYTES_PER_MS
  return Math.floor(budgetMs * bytesPerMs)
}

// Why: a TUI reading Windows console input records consumes a paste one key event at a time, and
// Codex 0.162.1 on a low-spec Win11 host took 5.1 s for 1,849 chars and 21.1 s for 9,249 (~2.3 ms/char).
const WINDOWS_INPUT_RECORD_PASTE_MS_PER_CHAR = 3

/** How long a held prompt may still need Enter: an input-record TUI's paste burst, or a launch composer not yet submit-ready. */
export function getAgentPromptHeldSubmitBudgetMs(
  platform: NodeJS.Platform,
  agent: TerminalAgent | null | undefined,
  pastePayload: string,
  composerReady: boolean
): number {
  if (!isTuiAgent(agent)) {
    return 0
  }
  const config = TUI_AGENT_CONFIG[agent]
  const launchMs = composerReady ? (config.submitRetryBudgetMs ?? 0) : 0
  const pasteBurstMs =
    platform === 'win32' && config.windowsInputRecordPasteNewline
      ? pastePayload.length * WINDOWS_INPUT_RECORD_PASTE_MS_PER_CHAR
      : 0
  // Why the cap: with the render gate (<= 8 s + ingest), ingest itself and this wait, delivery
  // stays <= 38 s, inside worker-start's 50 s grace once observation is shortened by delivery time.
  const capMs =
    AGENT_PROMPT_EFFECT_TIMEOUT_MS -
    2 * getTerminalPasteIngestMs(platform, Buffer.byteLength(pastePayload, 'utf8'))
  return Math.max(0, Math.min(Math.max(launchMs, pasteBurstMs), capMs))
}

// Codex dedupes a repeated placeholder label as `[Pasted Content N chars] #2`.
const PASTED_CONTENT_PLACEHOLDER = /\[Pasted Content (\d+) chars\](?: #\d+)?/g
// Why: a held 10,312-char prompt with 142 LFs read as 10,597 on Windows Codex 0.162.1, i.e. 2 more
// per LF plus 1 per Enter the burst absorbed; the slack absorbs small counting drift.
const HELD_PROMPT_EXTRA_CHARS_PER_LINE_FEED = 2
const HELD_PROMPT_COUNT_SLACK_CHARS = 8
const HELD_PROMPT_TEXT_MIN_CHARS = 32

/** Whether a composer draft is `prompt` still held, as Codex's paste placeholders or as text;
 *  `absorbedEnters` is how many Enters may have joined the paste as newlines. */
export function isHeldAgentPromptDraft(
  draft: string | undefined,
  prompt: string,
  absorbedEnters: number
): boolean {
  if (!draft) {
    return false
  }
  const expected = sanitizeAgentPromptText(prompt).replace(/\r\n?/g, '\n')
  let pastedChars = 0
  const literal = draft.replace(PASTED_CONTENT_PLACEHOLDER, (_match, count: string) => {
    pastedChars += Number(count)
    return ''
  })
  if (pastedChars > 0) {
    // Why nothing beside the placeholders: text the user typed or pasted in must not be submitted.
    if (literal.trim()) {
      return false
    }
    const expectedChars = [...expected].length
    const lineFeeds = expected.split('\n').length - 1
    // Why a sum: a burst read with a pause flushes as several placeholders.
    return (
      pastedChars >= expectedChars &&
      pastedChars <=
        expectedChars +
          lineFeeds * HELD_PROMPT_EXTRA_CHARS_PER_LINE_FEED +
          absorbedEnters +
          HELD_PROMPT_COUNT_SLACK_CHARS
    )
  }
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const shown = collapse(draft)
  const wanted = collapse(expected)
  // Why a long tail only: a scrolled composer shows the paste's end; a short or inner fragment
  // could be the user's own text that recurs in the prompt.
  return shown === wanted || (shown.length >= HELD_PROMPT_TEXT_MIN_CHARS && wanted.endsWith(shown))
}

export type AgentPromptSubmitDelayOptions = {
  lineSettleMsPerLine?: number
  lineCount?: number
}

/** Open-loop wait before Enter for agents with no settlement signal: the paste cannot have
 *  landed before it is ingested, and the child needs a settle window after that. Never
 *  capped -- a cap silently reintroduces the mid-paste Enter it exists to prevent. */
export function getAgentPromptSubmitDelayMs(
  platform: NodeJS.Platform,
  byteLength: number,
  options: AgentPromptSubmitDelayOptions = {}
): number {
  const lineCount = Math.max(1, options.lineCount ?? 1)
  const lineSettleMsPerLine = options.lineSettleMsPerLine ?? 0
  const lineSettleMs = lineSettleMsPerLine > 0 ? lineCount * lineSettleMsPerLine : 0
  return (
    AGENT_PROMPT_SUBMIT_SETTLE_MS + getTerminalPasteIngestMs(platform, byteLength) + lineSettleMs
  )
}

export function resolveAgentPromptSubmitDelayForAgent(
  platform: NodeJS.Platform,
  prompt: string,
  agent: TerminalAgent | null | undefined
): number {
  const config = isTuiAgent(agent) ? TUI_AGENT_CONFIG[agent] : undefined
  return getAgentPromptSubmitDelayMs(
    platform,
    Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8'),
    {
      lineSettleMsPerLine: config?.submitLineSettleMsPerLine,
      lineCount: countAgentTuiInputLines(prompt)
    }
  )
}

const ESCAPE = '\x1b'
const INERT_ESCAPE = '<ESC>'

export function sanitizeAgentPromptText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${INERT_ESCAPE}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

/** `leadLine` is typed, not pasted; folded to one line so it cannot submit. */
export function buildAgentPromptPasteBytes(prompt: string, leadLine?: string): string {
  // oxlint-disable-next-line no-control-regex -- the lead must type no C0 control or DEL.
  const lead = leadLine ? `${leadLine.replace(/[\x00-\x1f\x7f]+/g, ' ')} ` : ''
  return `${lead}${AGENT_PROMPT_BRACKETED_PASTE_START}${sanitizeAgentPromptText(prompt)}${AGENT_PROMPT_BRACKETED_PASTE_END}`
}

export function* iterateAgentPromptPasteChunks(
  prompt: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): Generator<string> {
  yield* iterateTerminalInputChunks(buildAgentPromptPasteBytes(prompt), maxChunkBytes)
}
