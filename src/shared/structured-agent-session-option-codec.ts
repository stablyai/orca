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

/** A saved option string as its catalog kind reads it: booleans by kind, not by a fixed id list. */
export function decodeCatalogOptionValue(
  kind: { type: 'select' | 'boolean' },
  value: SessionOptionValue | undefined
): SessionOptionValue | undefined {
  if (kind.type !== 'boolean' || typeof value !== 'string') {
    return value
  }
  return value === 'true' ? true : value === 'false' ? false : undefined
}

export function encodeCatalogOptionValue(
  kind: { type: 'select' | 'boolean' },
  value: SessionOptionValue
): string | null {
  if (kind.type === 'boolean') {
    return typeof value === 'boolean' ? String(value) : null
  }
  return typeof value === 'string' ? value : null
}
