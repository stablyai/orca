import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'

const DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS = 500
const WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS = 1_500
const MAX_AGENT_PROMPT_SUBMIT_DELAY_MS = 5_000
// Why: #13488 mid-size preambles were ~8–10KB; bytes/5 yields ~1.6–2s on darwin (vs bytes/20 still flooring at 500ms).
const AGENT_PROMPT_SUBMIT_DELAY_BYTES_PER_MS = 5

// Why: ConPTY (and long Claude pastes on macOS/Linux) need more time before Enter is accepted (#13488).
export function getAgentPromptSubmitDelayMs(
  platform: NodeJS.Platform,
  pasteByteLength = 0
): number {
  const base =
    platform === 'win32'
      ? WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS
      : DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS
  const sized =
    pasteByteLength > 0 ? Math.ceil(pasteByteLength / AGENT_PROMPT_SUBMIT_DELAY_BYTES_PER_MS) : 0
  return Math.min(MAX_AGENT_PROMPT_SUBMIT_DELAY_MS, Math.max(base, sized))
}

export const AGENT_PROMPT_SUBMIT_DELAY_MS = getAgentPromptSubmitDelayMs(process.platform)

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

export function buildAgentPromptPasteBytes(prompt: string): string {
  return `${AGENT_PROMPT_BRACKETED_PASTE_START}${sanitizeAgentPromptText(prompt)}${AGENT_PROMPT_BRACKETED_PASTE_END}`
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
