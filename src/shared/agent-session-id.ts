const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}
