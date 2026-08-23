export function deleteEnvironmentKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  if (!keys?.length) {
    return
  }
  if (platform !== 'win32') {
    for (const key of keys) {
      delete env[key]
    }
    return
  }
  const requested = new Set(keys.map((key) => key.toLowerCase()))
  for (const key of Object.keys(env)) {
    if (requested.has(key.toLowerCase())) {
      delete env[key]
    }
  }
}

export function findEnvironmentKey(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') {
    return env[name] === undefined ? undefined : name
  }
  const folded = name.toLowerCase()
  return Object.keys(env).find((key) => key.toLowerCase() === folded)
}
