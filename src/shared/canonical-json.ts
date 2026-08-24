// Why: stable key order with undefined stripped, so the same logical payload always
// hashes identically on both the CLI and runtime sides of a durable mutation.
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      result[key] = canonicalizeJson(source[key])
    }
  }
  return result
}
