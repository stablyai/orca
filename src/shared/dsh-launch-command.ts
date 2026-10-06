import { findInterpreterEntrypointToken } from './agent-command-line-entrypoint'

// DSH 0.2 accepts positional profiles; community dsh-tui/dst choose their own TUI profile.

/** Profiles that boot something other than the interactive terminal UI. */
const NON_INTERACTIVE_PROFILES = new Set([
  'web',
  'headless',
  'sdk',
  'sdk-minimal',
  'acp',
  'desktop'
])

/** Plugin management never boots an interactive pane. */
const SUBCOMMANDS = new Set(['plugin'])

/** Launcher flags that print a composed config and exit. */
const DUMP_FLAGS = new Set(['--dump-config', '--dump-default-config', '--dump-config-schema'])

/** Binaries that always boot `--profile dsh-tui` and forward the rest to the terminal app. */
const TUI_LAUNCHER_NAMES = new Set(['dsh-tui', 'dst'])

const PROGRAM_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/

function programBasename(token: string | undefined): string {
  const unquoted = token?.trim().replace(/^["']|["']$/g, '') ?? ''
  const basename = unquoted.split(/[\\/]/).pop() ?? unquoted
  return basename.toLowerCase().replace(PROGRAM_EXTENSION_RE, '')
}

function readProfileName(tokens: readonly string[], index: number): string | null {
  const token = tokens[index]
  if (token === undefined) {
    return null
  }
  if (token.startsWith('--profile=')) {
    return token.slice('--profile='.length)
  }
  return token === '--profile' ? (tokens[index + 1] ?? null) : null
}

/** Launcher flags that take a value, so the token after them is never an app argument. */
const LAUNCHER_FLAGS_WITH_VALUE = new Set(['--profile', '--from-default-profile', '--patch'])

/** Valueless launcher flags. */
const LAUNCHER_FLAGS = new Set(['-V', '--version', '-h', '--help', ...DUMP_FLAGS])

/** Splits `--profile=web` down to `--profile` so both spellings match one lookup. */
function flagName(token: string): string {
  return token.split('=', 1)[0]
}

function isLauncherToken(token: string): boolean {
  return LAUNCHER_FLAGS.has(token) || LAUNCHER_FLAGS_WITH_VALUE.has(flagName(token))
}

/**
 * Whether a `dsh` command line runs something other than the interactive agent.
 *
 * Only the launcher's own tokens are read. Everything after the first token the launcher
 * does not recognize belongs to the booted app (`dsh --profile dsh-tui --resume <id>`),
 * and a prompt or session id is free text that must never be read as a launcher flag.
 */
export function isDshNonInteractiveCommand(tokens: readonly string[]): boolean {
  const firstProgram = programBasename(tokens[0])
  const entrypoint = findInterpreterEntrypointToken([...tokens], firstProgram)
  const programIndex = entrypoint === null ? 0 : tokens.indexOf(entrypoint)
  if (TUI_LAUNCHER_NAMES.has(programBasename(tokens[programIndex]))) {
    return false
  }
  const indexOfArgs = programIndex + 1
  let index = indexOfArgs
  let profile: string | null = null
  const first = tokens[index]
  if (first !== undefined && !first.startsWith('-')) {
    if (SUBCOMMANDS.has(first)) {
      return true
    }
    profile = first
    index += 1
  }
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (DUMP_FLAGS.has(token)) {
      return true
    }
    if (!isLauncherToken(token)) {
      break
    }
    const explicitProfile = readProfileName(tokens, index)
    if (explicitProfile !== null && profile === null) {
      profile = explicitProfile
    }
    if (LAUNCHER_FLAGS_WITH_VALUE.has(token)) {
      index += 1
    }
  }
  return profile !== null && NON_INTERACTIVE_PROFILES.has(profile)
}
