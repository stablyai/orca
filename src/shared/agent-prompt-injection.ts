import { countAgentTuiInputLines } from './agent-tui-input-clear'
import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from './orchestration-timing-budgets'
import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'
import type { TerminalAgent } from './terminal-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'
/** Claude may leave a draft unsent when paste-end and Enter share a write; send Enter separately after this delay. */
export const AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS = 50

/** Unknown agents retain Claude's lead; known non-Claude TUIs need it separately because Codex drops typed text sharing the paste write (STA-8200). */
export function agentPromptTakesLeadLine(agent: TerminalAgent | null | undefined): boolean {
  return !isTuiAgent(agent) || TUI_AGENT_CONFIG[agent].pasteNeedsTypedRequest === true
}

/** OMP recognizes a submitted bracketed paste only when Enter shares its PTY write. */
export function agentPromptSubmitJoinsPasteFrame(agent: TerminalAgent | null | undefined): boolean {
  return agent === 'omp'
}

// Win11 bundled ConPTY ingest, 16KiB chunks: 2KB=14/25ms, 8KB=60/89ms, 40KB=347/440ms, 160KB=1662/1499ms, 320KB=3342/2969ms on two hosts. 64B/ms gives 1.5x margin over the slowest slope (0.0104ms/B); rendering was ~0ms.
const WINDOWS_CONPTY_INGEST_BYTES_PER_MS = 64
// macOS ingests 320KB in ~26ms; noise-dominated smaller samples justify 3x margin (about 4.1s at 16MiB).
const DEFAULT_PASTE_INGEST_BYTES_PER_MS = 4_096
// Bytes arriving does not prove the child attached the paste; retain 500ms settle, including measured 15–25ms fixed intercept.
const AGENT_PROMPT_SUBMIT_SETTLE_MS = 500

/** Ingest floor uses the PTY transport host platform, not the child command's OS. */
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

/** How long a held prompt may still need Enter: an input-record TUI's paste burst, or a composer not yet submit-ready. */
export function getAgentPromptHeldSubmitBudgetMs(
  platform: NodeJS.Platform,
  agent: TerminalAgent | null | undefined,
  pastePayload: string
): number {
  if (!isTuiAgent(agent)) {
    return 0
  }
  const config = TUI_AGENT_CONFIG[agent]
  const startupMs = config.submitRetryBudgetMs ?? 0
  const pasteBurstMs =
    platform === 'win32' && config.windowsInputRecordPasteNewline
      ? pastePayload.length * WINDOWS_INPUT_RECORD_PASTE_MS_PER_CHAR
      : 0
  // Why the cap: with the render gate (<= 8 s + ingest), ingest itself and this wait, delivery
  // stays <= 38 s, inside worker-start's 50 s grace once observation is shortened by delivery time.
  const capMs =
    AGENT_PROMPT_EFFECT_TIMEOUT_MS -
    2 * getTerminalPasteIngestMs(platform, Buffer.byteLength(pastePayload, 'utf8'))
  return Math.max(0, Math.min(Math.max(startupMs, pasteBurstMs), capMs))
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

/** Without a settlement signal, wait for ingest plus child settle; never cap the delay or Enter can race a large paste. */
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
