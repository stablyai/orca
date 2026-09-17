const MAX_PROVIDER_TURN_ID_LENGTH = 512

/** Keep provider-owned identifiers bounded before they cross a transport boundary. */
export function normalizeProviderTurnIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_PROVIDER_TURN_ID_LENGTH) {
    return undefined
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return undefined
    }
  }
  return trimmed
}

export const PROVIDER_TURN_ID_MAX_LENGTH = MAX_PROVIDER_TURN_ID_LENGTH
