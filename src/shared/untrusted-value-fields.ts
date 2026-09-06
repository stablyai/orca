/**
 * The host half of the ownership tri-state: reading fields off values Orca did
 * not construct.
 *
 * A `catch` receives whatever was thrown — a string, `undefined`, a revoked
 * Proxy, an object whose getter throws. A subprocess wrapper resolves whatever
 * it likes. Reading `value.code` or `value.stdout` directly lets that read's own
 * exception escape the very guard meant to normalise it, so the caller gets
 * neither an answer nor a typed failure. That has now happened at four separate
 * sites in this lane, so every such read goes through here.
 *
 * The contract is uniform: an unreadable or wrongly-typed field is `undefined`,
 * which callers must treat as "could not determine" — never as a negative
 * answer.
 */
function readField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

export function readUntrustedString(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' ? field : undefined
}

export function readUntrustedBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key)
  return typeof field === 'boolean' ? field : undefined
}

/**
 * `null` is a real value for an exit code (killed by signal), so it is reported
 * distinctly from `undefined`, which means the field could not be read.
 */
export function readUntrustedExitCode(value: unknown, key: string): number | null | undefined {
  const field = readField(value, key)
  if (field === null) {
    return null
  }
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}
