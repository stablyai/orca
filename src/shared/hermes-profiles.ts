import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './agent-launch/startup/tui-agent-startup-shell'

/** Hermes' own profile-id rule (`hermes_cli.profiles._PROFILE_ID_RE`). */
export const HERMES_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type HermesProfilesSnapshot = {
  /** Named profiles under `<HERMES_HOME>/profiles`; the root/default profile is not listed. */
  profiles: string[]
  /** The profile a bare `hermes` invocation would use, or `default` for the root profile. */
  activeProfile: string
}

export const EMPTY_HERMES_PROFILES: HermesProfilesSnapshot = {
  profiles: [],
  activeProfile: 'default'
}

export function isHermesProfileName(value: string): boolean {
  return HERMES_PROFILE_NAME_PATTERN.test(value)
}

/** The profile flag Hermes' pre-parser accepts, kept separate from free-form Arguments. */
export function hermesProfileArgs(profile: string | null | undefined): string[] {
  return profile && isHermesProfileName(profile) ? ['--profile', profile] : []
}

/**
 * Replace any explicit profile selector in `args` with `profile`; `null` removes it.
 *
 * Hermes scans its whole argv for `-p`/`--profile` before argparse, so this keeps
 * the rest of the user's saved Arguments (and Orca's permission flags) intact.
 */
export function withHermesProfileArgs(
  args: string,
  profile: string | null | undefined,
  shell: AgentStartupShell = 'posix'
): string {
  if (profile && !isHermesProfileName(profile)) {
    return args
  }
  const parsed = tokenizeStartupCommand(args, shell)
  if (!parsed.ok) {
    return args
  }
  const kept: string[] = []
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]
    if (token === '--') {
      kept.push(...parsed.tokens.slice(index))
      break
    }
    if (token === '--profile' || token === '-p') {
      index += 1
      continue
    }
    if (token.startsWith('--profile=')) {
      continue
    }
    kept.push(token)
  }
  const terminator = kept.indexOf('--')
  const profileArgs = hermesProfileArgs(profile)
  if (terminator === -1) {
    kept.push(...profileArgs)
  } else {
    kept.splice(terminator, 0, ...profileArgs)
  }
  return kept
    .map((token) => (/^[A-Za-z0-9_./:=@+-]+$/.test(token) ? token : quoteStartupArg(token, shell)))
    .join(' ')
}
