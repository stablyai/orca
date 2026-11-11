// Hermes profile ids are lowercase letters, digits, `-` and `_`, so one needs no shell quoting.
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The profile a HERMES_HOME names when it is `<hermes root>/profiles/<id>`; null otherwise. */
export function hermesProfileFromHome(home: string | undefined): string | null {
  const parts =
    home
      ?.trim()
      .split(/[\\/]+/)
      .filter(Boolean) ?? []
  const id = parts.at(-1)
  return parts.at(-2) === 'profiles' && id && PROFILE_ID.test(id) ? id : null
}

export type HermesSetupAction = 'version' | 'acp-check' | 'setup'

const ACTION_ARGS: Record<HermesSetupAction, string> = {
  version: '--version',
  'acp-check': 'acp --check',
  setup: 'setup'
}

/** One command per action, with `-p` instead of an env prefix so every shell runs it as typed. */
export function hermesSetupCommand(
  executable: string,
  profile: string | null,
  action: HermesSetupAction
): string {
  return [executable, ...(profile ? ['-p', profile] : []), ACTION_ARGS[action]].join(' ')
}
