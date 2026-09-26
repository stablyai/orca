/** Leading assignments are data, never shell expressions. */
export function extractLeadingEnvAssignments(tokens: string[]): {
  env?: Record<string, string>
  rest: string[]
} {
  const assignments = new Map<string, string>()
  let index = 0
  for (const token of tokens) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      break
    }
    const equals = token.indexOf('=')
    const name = token.slice(0, equals)
    // Preserve last-assignment order when Windows folds differently cased names.
    assignments.delete(name)
    assignments.set(name, token.slice(equals + 1))
    index++
  }
  return {
    ...(assignments.size ? { env: Object.fromEntries(assignments) } : {}),
    rest: tokens.slice(index)
  }
}

export function mergeCommandEnvironment(
  base: Record<string, string | undefined> | undefined,
  overrides: Record<string, string> | undefined,
  platform: NodeJS.Platform
): Record<string, string | undefined> | undefined {
  if (!overrides) {
    return base
  }
  const entries = [...Object.entries(base ?? process.env), ...Object.entries(overrides)]
  // Windows keys share one spelling so guards cannot retain differently cased aliases.
  return Object.fromEntries(
    platform === 'win32' ? entries.map(([key, value]) => [key.toUpperCase(), value]) : entries
  )
}
