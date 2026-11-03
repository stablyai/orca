export function isCustomAcpAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^custom-[a-z0-9][a-z0-9_-]{0,56}$/.test(value)
}
