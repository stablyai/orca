import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'

// Why: Codex/Claude can need a render turn after bracketed-paste end before
// Enter is accepted as submit, not paste content. Match the proven runtime gap.
export const AGENT_PROMPT_SUBMIT_DELAY_MS = 500

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
