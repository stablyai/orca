const MAX_AGENT_SESSION_OPTION_ENTRIES = 32
const MAX_AGENT_SESSION_OPTION_TEXT_LENGTH = 512

function isBoundedOptionText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AGENT_SESSION_OPTION_TEXT_LENGTH
  )
}

export function isAgentSessionOptions(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_AGENT_SESSION_OPTION_ENTRIES &&
    entries.every(([key, option]) => isBoundedOptionText(key) && isBoundedOptionText(option))
  )
}
