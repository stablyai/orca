/**
 * Reads one own data property off a caught value.
 *
 * Why: failure reporting runs inside catch blocks, where throwing again replaces the failure
 * being reported with a second one. `in`, plain property access, and `instanceof` all run
 * accessors or Proxy traps that can throw, so this reads a descriptor instead and accepts only
 * a data property. Inherited values are ignored too, so a polluted prototype cannot supply one.
 *
 * A Proxy still observes the descriptor lookup — no standard inspection avoids that — but the
 * result is contained: this returns undefined instead of propagating a throw.
 */
export function errorOwnDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}
