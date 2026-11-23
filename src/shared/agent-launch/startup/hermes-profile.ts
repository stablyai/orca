/** Hermes' own profile id rule (hermes_cli/profiles.py); `default` names the root, not a folder. */
export const HERMES_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

// <root>/state.db is the default profile's store; <root>/profiles/<name>/state.db a named profile's.
// Session History rows name one conversation in it as `<store>#<session id>`.
const HERMES_STATE_DB = /(?:[\\/]profiles[\\/]([^\\/]+))?[\\/]state\.db(?:#[^\\/]+)?$/i

/** `-p <profile>` for a session in that profile's store: bare `hermes` follows the sticky
 *  `hermes profile use` choice, which may be another profile. Profile ids are literal in every shell. */
export function hermesStateDbProfileArgs(stateDbPath: string | null | undefined): string[] {
  const profile = hermesStateDbProfile(stateDbPath)
  return profile ? ['-p', profile] : []
}

/** The profile a Hermes store path names, or null when the path is not one of its stores.
 *  The root home is `default`, so callers can compare stores without spelling the root out. */
export function hermesStateDbProfile(stateDbPath: string | null | undefined): string | null {
  const match = stateDbPath?.match(HERMES_STATE_DB)
  if (!match) {
    return null
  }
  const profile = match[1] ?? 'default'
  return profile === 'default' || HERMES_PROFILE_NAME.test(profile) ? profile : null
}

/** The Hermes root a home belongs to: named profiles live at <root>/profiles/<name>. */
export function hermesProfileRoot(home: string): string {
  const match = home.match(/^(.*)[\\/]profiles[\\/][^\\/]+[\\/]?$/)
  return match?.[1] || home
}

/** A hook-reported profile id that names a `--profile` argument: `default` is the root and
 *  `custom` a Hermes-Desktop-chosen home, so neither may be spliced into argv. */
export function readHermesProfileName(value: unknown): string | undefined {
  const profile = typeof value === 'string' ? value.trim() : ''
  return profile === 'default' || profile === 'custom' || !HERMES_PROFILE_NAME.test(profile)
    ? undefined
    : profile
}
