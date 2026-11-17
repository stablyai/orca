// Value equality for IPC/JSON-shaped data (primitives, arrays, plain objects, Sets of primitives).
// Polls compare a fresh read with what the store already holds so an unchanged read keeps the
// existing references and publishes nothing.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function plainDataEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false
  }
  if (a instanceof Set || b instanceof Set) {
    return (
      a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v))
    )
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => plainDataEqual(value, b[index]))
    )
  }
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && plainDataEqual(a[key], b[key]))
  )
}
