import { countAgentTuiInputLines } from './agent-tui-input-clear'
import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'

/** Why unknown agents keep the lead: an unidentified Claude still needs it, while known non-Claude
 *  TUIs get pre-lead bytes because Codex drops typed text that shares the paste's write (STA-8200). */
export function agentPromptTakesLeadLine(agent: TuiAgent | null | undefined): boolean {
  return !agent || TUI_AGENT_CONFIG[agent].pasteNeedsTypedRequest === true
}

/** OMP recognizes a submitted bracketed paste only when Enter shares its PTY write. */
export function agentPromptSubmitJoinsPasteFrame(agent: TuiAgent | null | undefined): boolean {
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
  agent: TuiAgent | null | undefined
): number {
  const config = agent ? TUI_AGENT_CONFIG[agent] : undefined
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

export function buildAgentPromptSubmitBytes(): string {
  return AGENT_PROMPT_SUBMIT
}

export function* iterateAgentPromptPasteChunks(
  prompt: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): Generator<string> {
  yield* iterateTerminalInputChunks(buildAgentPromptPasteBytes(prompt), maxChunkBytes)
}
