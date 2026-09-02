function getEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const exactValue = env[name]
  if (typeof exactValue === 'string') {
    return exactValue
  }
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  const value = key ? env[key] : undefined
  return typeof value === 'string' ? value : undefined
}

export function expandWindowsEnvironmentVariables(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    return getEnvironmentVariable(env, name) ?? match
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
