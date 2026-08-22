import { getCommandTokenPathBasename } from './command-token-scanner'
import { optionName } from './print-mode-headless-command'

// Why: taken from Bob Shell 2.0.1's `bob --help`. `chat` is the only subcommand that
// leaves an interactive UI for Orca to host; `run` is headless, `mcp` manages config,
// and the remaining flags print and exit.
const BOB_INTERACTIVE_SUBCOMMANDS = new Set(['chat'])
const BOB_ONE_SHOT_FLAGS = new Set([
  '--prompt',
  '-p',
  '--list-tasks',
  '--version',
  '-v',
  '--show-license',
  '--help',
  '-h'
])
// Why: `--resume [task-id]` takes an optional value that must not read as a prompt.
const BOB_OPTIONS_WITH_OPTIONAL_VALUE = new Set(['--resume', '-r'])

const BOB_EXECUTABLE_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/i

const BOB_SCRIPT_EXTENSION_RE = /\.(?:js|mjs|cjs)$/i
const BOB_PACKAGE_PATH_RE = /node_modules[\\/]bobshell[\\/]/i

function isBobExecutableToken(token: string): boolean {
  const path = token.trim().replace(/^["']|["']$/g, '')
  const basename = getCommandTokenPathBasename(path)
  if (basename.toLowerCase().replace(BOB_EXECUTABLE_EXTENSION_RE, '') !== 'bob') {
    return false
  }
  // Why: any repo can ship a `bob.js`; only the bobshell package's script is IBM Bob.
  return !BOB_SCRIPT_EXTENSION_RE.test(basename) || BOB_PACKAGE_PATH_RE.test(path)
}

// Why: Bob ships as a node script, so recognition also sees it as `node …/bob.js`.
function bobArgumentStartIndex(tokens: readonly string[]): number {
  const executableIndex = tokens.findIndex(isBobExecutableToken)
  return executableIndex === -1 ? 1 : executableIndex + 1
}

export function isBobHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = bobArgumentStartIndex(tokens); index < tokens.length; index += 1) {
    const token = tokens[index]
    // Why: `--` ends option parsing, so what follows is a positional (one-shot) prompt.
    if (token === '--') {
      return index + 1 < tokens.length
    }
    if (!token.startsWith('-')) {
      // Why: the first positional is the subcommand; only `chat` stays interactive.
      return !BOB_INTERACTIVE_SUBCOMMANDS.has(token)
    }
    const name = optionName(token)
    if (BOB_ONE_SHOT_FLAGS.has(name) || /^-p[^-]/.test(name)) {
      return true
    }
    if (name === token && BOB_OPTIONS_WITH_OPTIONAL_VALUE.has(name)) {
      const next = tokens[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        index += 1
      }
    }
  }
  // Why: bare `bob` opens the chat UI on a TTY.
  return false
}
