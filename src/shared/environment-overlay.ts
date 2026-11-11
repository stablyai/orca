/** Windows children select the first sorted alias, so configured names must replace every alias. */
export function overlayEnvironmentVariables<T extends string | undefined>(
  base: Readonly<Record<string, T>>,
  overrides: Readonly<Record<string, T>> | undefined,
  platform: NodeJS.Platform
): Record<string, T> {
  if (platform !== 'win32') {
    return { ...base, ...overrides }
  }
  const normalized: Record<string, T> = {}
  for (const [key, value] of Object.entries(overrides ?? {})) {
    normalized[key.toUpperCase()] = value
  }
  const overlaid = new Set(Object.keys(normalized))
  const merged = { ...base }
  for (const key of Object.keys(merged)) {
    if (overlaid.has(key.toUpperCase())) {
      delete merged[key]
    }
  }
  return { ...merged, ...normalized }
}
