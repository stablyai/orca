const BOB_HEADLESS_PROMPT_FLAGS = new Set(['--prompt', '-p'])
const BOB_INTERACTIVE_PROMPT_FLAGS = new Set(['--prompt-interactive', '-i'])
const BOB_OPTIONS_WITH_VALUE = new Set([
  '--chat-mode',
  '--max-coins',
  '--instance-id',
  '--team-id',
  '--model',
  '-m',
  '--approval-mode',
  '--allowed-mcp-server-names',
  '--allowed-tools',
  '--resume',
  '-r',
  '--delete-session',
  '--include-directories',
  '--output-format',
  '-o'
])

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function basename(token: string): string {
  const name = token
    .trim()
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()
  return (name ?? '').toLowerCase().replace(PROCESS_EXTENSION_RE, '')
}

function isBobExecutableToken(token: string): boolean {
  return basename(token) === 'bob'
}

function findBobExecutableIndex(tokens: readonly string[]): number {
  const index = tokens.findIndex(isBobExecutableToken)
  return index === -1 ? 0 : index
}

function isBobHeadlessPromptFlag(token: string): boolean {
  const name = optionName(token)
  return BOB_HEADLESS_PROMPT_FLAGS.has(name) || /^-p[^-]/.test(name)
}

function isBobInteractivePromptFlag(token: string): boolean {
  const name = optionName(token)
  return BOB_INTERACTIVE_PROMPT_FLAGS.has(name) || /^-i[^-]/.test(name)
}

function optionConsumesNextValue(token: string): boolean {
  const name = optionName(token)
  return name === token && BOB_OPTIONS_WITH_VALUE.has(name)
}

export function isBobHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  const bobIndex = findBobExecutableIndex(tokens)

  for (let index = bobIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (isBobHeadlessPromptFlag(token)) {
      return true
    }
    if (isBobInteractivePromptFlag(token)) {
      return false
    }
  }

  for (let index = bobIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return index + 1 < tokens.length
    }
    if (token.startsWith('-')) {
      if (optionConsumesNextValue(token)) {
        index += 1
      }
      continue
    }
    // Why: Bob positional prompts default to one-shot mode unless the command
    // uses -i/--prompt-interactive, which the earlier pass already handled.
    return true
  }

  return false
}
