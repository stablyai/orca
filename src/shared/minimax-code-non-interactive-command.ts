const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'init',
  'exec',
  'acp',
  'login',
  'logout',
  'update',
  'provider',
  'plugin'
])

function basename(token: string): string {
  return (token.replace(/\\/g, '/').split('/').pop() ?? token).toLowerCase()
}

export function isMiniMaxCodeNonInteractiveCommand(tokens: readonly string[]): boolean {
  const terminatorIndex = tokens.indexOf('--')
  const entrypointIndex = tokens.findIndex((token) => {
    const name = basename(token).replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    return name === 'mcode' || name === 'minimax-code' || name === 'cli.js'
  })
  if (entrypointIndex === -1) {
    return false
  }
  const commandIndex = entrypointIndex + 1
  if (terminatorIndex !== -1 && terminatorIndex <= commandIndex) {
    return false
  }
  return NON_INTERACTIVE_SUBCOMMANDS.has(tokens[commandIndex]?.toLowerCase() ?? '')
}
