import { join, posix, win32 } from 'node:path'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

function expandedReasonixDirectory(
  value: string | undefined,
  home: string,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (!value) {
    return undefined
  }
  const expanded = value
    .trim()
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback: string | undefined) => environment[name] || fallback || ''
    )
  const path = platform === 'win32' ? win32 : posix
  return expanded === '~'
    ? home
    : /^~[\\/]/.test(expanded)
      ? path.join(home, expanded.slice(2))
      : expanded
}

export function isReasonixRemoteConfigHome(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    value === value.trim() &&
    posix.isAbsolute(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || character === '\\'
    })
  )
}

export function reasonixConfigRoots(
  home: string,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>
): { configHome: string; stateHome: string } {
  const defaultHome =
    platform === 'win32'
      ? win32.join(
          environment.APPDATA?.trim() || win32.join(home, 'AppData', 'Roaming'),
          'reasonix'
        )
      : join(home, '.reasonix')
  const configHome = resolveAbsoluteDirOverride(
    expandedReasonixDirectory(environment.REASONIX_HOME, home, platform, environment),
    defaultHome,
    platform
  )
  return {
    configHome,
    stateHome: resolveAbsoluteDirOverride(
      expandedReasonixDirectory(environment.REASONIX_STATE_HOME, home, platform, environment),
      configHome,
      platform
    )
  }
}
