const MAX_OPTION_ENTRIES = 32
const MAX_OPTION_TEXT_LENGTH = 512

export function isAgentSessionOptions(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_OPTION_ENTRIES &&
    entries.every(
      ([key, option]) =>
        key.length > 0 &&
        key.length <= MAX_OPTION_TEXT_LENGTH &&
        typeof option === 'string' &&
        option.length > 0 &&
        option.length <= MAX_OPTION_TEXT_LENGTH
    )
  )
}
