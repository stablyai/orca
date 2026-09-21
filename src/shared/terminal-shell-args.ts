/**
 * Splits a shell arguments string into separate tokens, respecting single and double quotes
 * and variable whitespace. Preserves empty quoted arguments (e.g. `""` or `''`).
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false
  let hasToken = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      hasToken = true
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      hasToken = true
    } else if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken) {
    args.push(current)
  }
  return args
}

/**
 * Resolves effective shell arguments from an optional user-configured argument string.
 * Returns ['-l'] if unconfigured, or the parsed argument list if explicitly configured.
 */
export function resolveDefaultShellArgs(configuredArgs: string | undefined): string[] {
  if (configuredArgs === undefined) {
    return ['-l']
  }
  return parseShellArgs(configuredArgs.trim())
}
