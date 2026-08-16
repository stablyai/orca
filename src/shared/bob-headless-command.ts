import { getCommandTokenPathBasename } from './command-token-scanner'
import { optionName } from './print-mode-headless-command'

const BOB_ONE_SHOT_PROMPT_FLAGS = new Set(['--prompt', '-p'])
const BOB_INTERACTIVE_PROMPT_FLAGS = new Set(['--prompt-interactive', '-i'])

// Why: taken from Bob Shell 1.0.6's own option table, which hides `--auth-method`,
// `--extensions`, `--fake-responses` and `--record-responses` from `bob --help`.
const BOB_OPTIONS_WITH_VALUE = new Set([
  '--allowed-mcp-server-names',
  '--allowed-tools',
  '--approval-mode',
  '--auth-method',
  '--chat-mode',
  '--delete-session',
  '--extensions',
  '-e',
  '--fake-responses',
  '--include-directories',
  '--instance-id',
  '--max-coins',
  '--model',
  '-m',
  '--output-format',
  '-o',
  '--record-responses',
  '--resume',
  '-r',
  '--team-id'
])

const BOB_EXECUTABLE_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/i

function isBobExecutableToken(token: string): boolean {
  const basename = getCommandTokenPathBasename(token.trim().replace(/^["']|["']$/g, ''))
  return basename.toLowerCase().replace(BOB_EXECUTABLE_EXTENSION_RE, '') === 'bob'
}

// Why: Bob ships as a node script, so recognition also sees it as `node …/bob.js`.
function bobArgumentStartIndex(tokens: readonly string[]): number {
  const executableIndex = tokens.findIndex(isBobExecutableToken)
  return executableIndex === -1 ? 1 : executableIndex + 1
}

export function isBobHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = bobArgumentStartIndex(tokens); index < tokens.length; index += 1) {
    const token = tokens[index]
    // Why: `--` ends option parsing, so what follows is the positional prompt.
    if (token === '--') {
      return index + 1 < tokens.length
    }
    if (!token.startsWith('-')) {
      // Why: positional prompts run one-shot, and `mcp`/`extensions` are management
      // subcommands - neither leaves an interactive shell for Orca to host.
      return true
    }
    const name = optionName(token)
    if (BOB_ONE_SHOT_PROMPT_FLAGS.has(name) || /^-p[^-]/.test(name)) {
      return true
    }
    if (BOB_INTERACTIVE_PROMPT_FLAGS.has(name) || /^-i[^-]/.test(name)) {
      return false
    }
    // Why: `--flag value` consumes the next token, which is not a positional prompt.
    if (name === token && BOB_OPTIONS_WITH_VALUE.has(name)) {
      index += 1
    }
  }
  return false
}
