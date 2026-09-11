export function expandWindowsEnvironmentVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  let keysByLowerName: Map<string, string> | undefined
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const exact = env[name]
    if (typeof exact === 'string') {
      return exact
    }
    if (!keysByLowerName) {
      keysByLowerName = new Map()
      for (const key of Object.keys(env)) {
        const lower = key.toLowerCase()
        if (!keysByLowerName.has(lower)) {
          keysByLowerName.set(lower, key)
        }
      }
    }
    const key = keysByLowerName.get(name.toLowerCase())
    const replacement = key ? env[key] : undefined
    return typeof replacement === 'string' ? replacement : match
  })
}

export function expandWindowsPathEnvironmentVariables(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    return
  }
  const sourceEnv = { ...env }
  for (const key of Object.keys(env)) {
    const value = env[key]
    if (key.toLowerCase() !== 'path' || typeof value !== 'string') {
      continue
    }
    env[key] = expandWindowsEnvironmentVariables(value, sourceEnv)
  }
}
