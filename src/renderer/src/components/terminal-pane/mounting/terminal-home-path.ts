export function resolveTerminalHomePathFromEnv(
  env: Record<string, string> | undefined
): string | null {
  const home = env?.HOME?.trim()
  if (home) {
    return home
  }
  const userProfile = env?.USERPROFILE?.trim()
  if (userProfile) {
    return userProfile
  }
  const homeDrive = env?.HOMEDRIVE?.trim()
  const homePath = env?.HOMEPATH?.trim()
  return homeDrive && homePath ? `${homeDrive}${homePath}` : null
}
