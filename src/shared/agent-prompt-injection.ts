import { countAgentTuiInputLines } from './agent-tui-input-clear'
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
