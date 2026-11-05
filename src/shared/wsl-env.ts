export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)
  const tokenNames = new Set(tokens.map((token) => token.split('/')[0]))

  for (const key of keys) {
    if (!tokenNames.has(key)) {
      tokens.push(key)
      tokenNames.add(key)
    }
  }

  env.WSLENV = tokens.join(':')
}
