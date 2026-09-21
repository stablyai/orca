import type { SessionOptionValue } from './native-chat-session-options'

const STRUCTURED_BOOLEAN_OPTION_IDS = new Set(['fastMode'])

export function encodeStructuredAgentSessionOptionValue(
  optionId: string,
  value: SessionOptionValue
): string | null {
  if (STRUCTURED_BOOLEAN_OPTION_IDS.has(optionId)) {
    return typeof value === 'boolean' ? String(value) : null
  }
  return typeof value === 'string' ? value : null
}

export function decodeStructuredAgentSessionOptionValue(
  optionId: string,
  value: string
): SessionOptionValue | null {
  if (!STRUCTURED_BOOLEAN_OPTION_IDS.has(optionId)) {
    return value
  }
  return value === 'true' ? true : value === 'false' ? false : null
}
