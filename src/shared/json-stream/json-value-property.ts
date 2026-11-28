/** A parsed JSON value's own `key`, or undefined when it isn't an object with that key. */
export function jsonProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

/** A parsed JSON value as a plain object (arrays excluded), or null. */
export function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  // Spread defines data properties; Object.assign invokes the legacy __proto__ setter.
  return { ...value }
}
