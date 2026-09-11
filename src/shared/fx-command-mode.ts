const FX_OPTIONS_WITH_VALUE = new Set(['--context-limit', '--add-dir', '--resume'])
const FX_NON_INTERACTIVE_COMMANDS = new Set(['ask', 'acp'])

function executableName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

export function isNonInteractiveFxCommand(tokens: readonly string[]): boolean {
  const executableIndex = tokens.findIndex((token) => executableName(token) === 'fx')
  if (executableIndex === -1) {
    return false
  }

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase() ?? ''
    if (token === '--') {
      return false
    }
    if (FX_OPTIONS_WITH_VALUE.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    return FX_NON_INTERACTIVE_COMMANDS.has(token)
  }
  return false
}
