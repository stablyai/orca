export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)
  const tokenNames = new Set(tokens.map((token) => token.split('/')[0]))

  for (const key of keys) {
    const name = key.split('/')[0]
    if (!tokenNames.has(name)) {
      tokens.push(key)
      tokenNames.add(name)
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
