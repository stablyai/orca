function wslEnvVariableName(token: string): string {
  const slash = token.indexOf('/')
  const name = slash === -1 ? token : token.slice(0, slash)
  return name.toUpperCase()
}

/** One WSLENV entry per variable. A later registration replaces any earlier flag for that name. */
export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  let tokens = existing.split(':').filter(Boolean)

  for (const key of keys) {
    const name = wslEnvVariableName(key)
    tokens = [...tokens.filter((token) => wslEnvVariableName(token) !== name), key]
  }

  env.WSLENV = tokens.join(':')
}
