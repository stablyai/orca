function mergeWslenvEntry(existing: string, requested: string): string {
  const [existingName, ...existingFlags] = existing.split('/')
  const [requestedName, ...requestedFlags] = requested.split('/')
  if (existingName !== requestedName) {
    return requested
  }
  // A bare request must not strip flags the user already set (e.g. a /p path var).
  if (requestedFlags.length === 0) {
    return existing
  }
  // A flagged request replaces a conflicting or unflagged token for the same variable.
  const missing = requestedFlags.filter((flag) => !existingFlags.includes(flag))
  return missing.length === 0 ? existing : requested
}

export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)

  for (const key of keys) {
    const name = key.split('/')[0]
    const index = tokens.findIndex((token) => token.split('/')[0] === name)
    if (index === -1) {
      tokens.push(key)
    } else if (tokens[index] !== undefined) {
      tokens[index] = mergeWslenvEntry(tokens[index], key)
    }
  }

  env.WSLENV = tokens.join(':')
}

/** A Windows shell can spawn WSL tools that inherit only WSLENV-listed variables. */
export function addTerminalHandleToWslEnv(env: Record<string, string | undefined>): void {
  if (env.ORCA_TERMINAL_HANDLE) {
    addWslEnvKeys(env, ['ORCA_TERMINAL_HANDLE/u'])
  }
}
