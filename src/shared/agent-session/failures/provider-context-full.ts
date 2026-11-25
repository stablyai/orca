import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type AgentSessionFailureFact
} from './agent-session-failure'

type ProviderContextError = {
  code?: unknown
  message?: unknown
  status?: unknown
}

const CONTEXT_FULL_CODES = new Set([
  'contextWindowExceeded',
  'ContextWindowExceeded',
  'context_length_exceeded',
  'context_window_exceeded',
  'prompt_too_long'
])
const GENERIC_ERROR_CODES = new Set([
  'invalid_request_error',
  'invalidRequest',
  'bad_request',
  'badRequest',
  'other'
])
const CONTEXT_FULL_MESSAGES = [
  /^(?:the )?prompt is too long(?:$|[:.!])/i,
  /^request (?:size )?exceeds (?:the )?model(?:'s)? context window\b/i,
  /^(?:this model's )?maximum context length (?:is \d|exceeded\b)/i,
  /^context (?:length|window) (?:has been )?exceeded\b/i,
  /^Codex ran out of room in the model's context window(?:$|[.!])/i
]

/** Only provider error fields belong here, never transcript text, usage reports or stderr. */
export function providerContextFullFailure(
  error: ProviderContextError
): AgentSessionFailureFact | null {
  if (error.status !== undefined && error.status !== 400 && error.status !== 413) {
    return null
  }
  if (error.code !== undefined && error.code !== null) {
    if (typeof error.code !== 'string' || error.code.length > 64) {
      return null
    }
    if (CONTEXT_FULL_CODES.has(error.code)) {
      return agentSessionFailureFact('contextFull')
    }
    if (!GENERIC_ERROR_CODES.has(error.code)) {
      return null
    }
  }
  const message =
    typeof error.message === 'string'
      ? error.message.slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS).trim()
      : ''
  return CONTEXT_FULL_MESSAGES.some((pattern) => pattern.test(message))
    ? agentSessionFailureFact('contextFull')
    : null
}
