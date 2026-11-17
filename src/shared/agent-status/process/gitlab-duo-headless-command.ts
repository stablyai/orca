import { optionName } from './print-mode-headless-command'

// Duo 10.4 root options that consume the next token; a goal like `run` must not read as the run subcommand.
const DUO_VALUE_FLAGS = new Set([
  '-C',
  '--cwd',
  '--gitlab-base-url',
  '--gitlab-auth-token',
  '--log-level',
  '--git-http-user',
  '--git-http-password',
  '--git-user-email',
  '--git-user-name',
  '--git-author-email',
  '--git-author-name',
  '--telemetry-enabled',
  '--sandbox',
  '--sandbox-config',
  '--existing-session-id',
  '--import-session',
  '-g',
  '--goal',
  '--connection-type',
  '--model',
  '--skill'
])
const DUO_OPTIONAL_VALUE_FLAGS = new Set(['--session-tracking-enabled', '--startup-cards'])
const DUO_NON_TUI_FLAGS = new Set(['-h', '--help', '-v', '--version', '--install', '--update'])

/** Duo's TUI takes no positionals, so any subcommand (run, export, config, glab's update…) never opens it. */
export function isGitlabDuoNonInteractiveCommand(tokens: readonly string[]): boolean {
  const start = tokens[1] === 'duo' && tokens[2] === 'cli' ? 3 : 1
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return index + 1 < tokens.length
    }
    if (!token.startsWith('-')) {
      return true
    }
    const name = optionName(token)
    if (DUO_NON_TUI_FLAGS.has(name)) {
      return true
    }
    if (name !== token) {
      continue
    }
    if (DUO_VALUE_FLAGS.has(name)) {
      index += 1
    } else if (DUO_OPTIONAL_VALUE_FLAGS.has(name) && !tokens[index + 1]?.startsWith('-')) {
      index += 1
    }
  }
  return false
}
