// Provider event-name normalization shared by routing and provider modules.

export function normalizeHookEventName(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

export function isGrokEvent(eventName: unknown, ...expected: readonly string[]): boolean {
  return expected.includes(normalizeHookEventName(eventName))
}
