import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'
import type { TuiAgent } from './types'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'

const DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS = 500
const WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS = 1_500

// Why: ConPTY renders long bracketed pastes more slowly; an early Enter leaves the task in the agent input buffer.
export function getAgentPromptSubmitDelayMs(platform: NodeJS.Platform): number {
  return platform === 'win32'
    ? WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS
    : DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS
}

export const AGENT_PROMPT_SUBMIT_DELAY_MS = getAgentPromptSubmitDelayMs(process.platform)

const ESCAPE = '\x1b'
const INERT_ESCAPE = '<ESC>'

// Why (#9838): Grok's welcome/composer can swallow bracketed-paste frames while
// still accepting plain `terminal send --enter`. Prefer the path that matches
// the working manual workaround for dispatch --inject.
const PLAIN_TEXT_AGENT_PROMPT_AGENTS = new Set<TuiAgent>(['grok'])

export function usesBracketedPasteForAgentPrompt(agent: TuiAgent | null | undefined): boolean {
  if (!agent) {
    return true
  }
  return !PLAIN_TEXT_AGENT_PROMPT_AGENTS.has(agent)
}

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

/** Body written before the delayed submit Enter. Bracketed paste for most agents; plain text for Grok (#9838). */
export function buildAgentPromptBodyBytes(prompt: string, agent?: TuiAgent | null): string {
  if (usesBracketedPasteForAgentPrompt(agent)) {
    return buildAgentPromptPasteBytes(prompt)
  }
  return sanitizeAgentPromptText(prompt)
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
