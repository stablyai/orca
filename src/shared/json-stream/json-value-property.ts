/** `value[key]` of a parsed JSON value, or undefined when it isn't an object with that key. */
export function jsonProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** A parsed JSON value as a plain object (arrays excluded), or null. */
export function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const object: Record<string, unknown> = {}
  return Object.assign(object, value)
}
