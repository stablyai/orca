// DeepSeek Harness ships one binary, `dsh`, and boots a *profile* with it. Only the
// `dsh-tui` profile paints an interactive composer; `web` serves HTTP, `headless` answers
// one task and exits, `sdk`/`sdk-minimal`/`acp` speak JSON-RPC on stdio, and `plugin` is
// package management. All five are `dsh` in the process table, so foreground recognition
// has to read the profile to tell an agent pane from a server or a one-shot.
//
// `dsh-tui` (and its `dst` alias) forward straight to `dsh --profile dsh-tui`, so they are
// always interactive and never reach this matcher.

/** Profiles that boot something other than the interactive terminal UI. */
const NON_INTERACTIVE_PROFILES = new Set([
  'web',
  'headless',
  'sdk',
  'sdk-minimal',
  'acp',
  'desktop'
])

/** Bare-word subcommands the launcher accepts: `plugin` boots no profile at all, and `web`
 *  is the documented alias for `--profile web`. Neither hosts an interactive pane. */
const SUBCOMMANDS = new Set(['plugin', 'web'])

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
  // Why first: `dsh-tui`/`dst` have already chosen the interactive profile, and everything
  // after them is the TERMINAL APP's argv — a `--resume` id or a workspace target. A
  // workspace folder named `web` or `plugin` is an ordinary directory name, and reading it
  // as a `dsh` subcommand would mark a live agent pane non-interactive, costing it status
  // hooks and prompt delivery. Index 1 as well as 0 because a node shim puts the launcher
  // script path there.
  if (
    TUI_LAUNCHER_NAMES.has(programBasename(tokens[0])) ||
    TUI_LAUNCHER_NAMES.has(programBasename(tokens[1]))
  ) {
    return false
  }
  let profile: string | null = null
  let index = 1
  // Skip the leading non-flag tokens: an interpreter invocation puts the script path here.
  while (index < tokens.length && !isLauncherToken(tokens[index])) {
    const token = tokens[index]
    if (SUBCOMMANDS.has(token)) {
      return true
    }
    if (!token.startsWith('-') && index > 1) {
      // A bare word that is neither a subcommand nor a flag: the app's arguments start here.
      return false
    }
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
