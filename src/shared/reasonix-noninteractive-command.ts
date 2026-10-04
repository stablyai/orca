import { comparablePath, findInterpreterEntrypointToken } from './agent-command-line-entrypoint'

const VALUE_OPTIONS = new Set([
  '--model',
  '--max-steps',
  '--dir',
  '--effort',
  '--permission-mode',
  '--add-dir',
  '--allowed-tools',
  '--allowedTools',
  '--profile',
  '--preset'
])

// Reasonix 1.39.7 routes only bare/chat/code or a leading interactive flag to its TUI.
export function isReasonixNonInteractiveCommand(tokens: readonly string[]): boolean {
  const first =
    comparablePath(tokens[0] ?? '')
      .split('/')
      .pop()
      ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '') ?? ''
  const entrypoint = findInterpreterEntrypointToken(tokens, first)
  const start = entrypoint ? tokens.indexOf(entrypoint) + 1 : 1
  const command = tokens[start]
  if (!command) {
    return false
  }
  if (!command.startsWith('-') && command !== 'chat' && command !== 'code') {
    return true
  }
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return false
    }
    const name = token.split('=', 1)[0]
    if (
      name === '--print' ||
      name === '-p' ||
      name === '--acp' ||
      name === '--help' ||
      name === '-h' ||
      name === '--version' ||
      name === '-v'
    ) {
      return true
    }
    if (VALUE_OPTIONS.has(name) && !token.includes('=')) {
      index += 1
    }
    // --resume has an optional value; a quoted flag-shaped value is not an option.
    if (
      (name === '--resume' || name === '-r') &&
      !token.includes('=') &&
      tokens[index + 1] &&
      !tokens[index + 1].startsWith('-')
    ) {
      index += 1
    }
  }
  return false
}
