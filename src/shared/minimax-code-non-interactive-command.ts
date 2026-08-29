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
  const entrypointIndex = tokens.findIndex((token) => {
    const name = basename(token).replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    return name === 'mcode' || name === 'minimax-code' || name === 'cli.js'
  })
  if (entrypointIndex === -1) {
    return false
  }
  let commandIndex = entrypointIndex + 1
  while (commandIndex < tokens.length) {
    const token = tokens[commandIndex]?.toLowerCase() ?? ''
    if (token === '--') {
      return false
    }
    if (token === '-c' || token === '--continue' || token.startsWith('--session=')) {
      commandIndex += 1
      continue
    }
    if (token === '--session') {
      if (tokens[commandIndex + 1] === '--') {
        commandIndex += 2
        continue
      }
      commandIndex += tokens[commandIndex + 1]?.startsWith('-') ? 1 : 2
      continue
    }
    return NON_INTERACTIVE_SUBCOMMANDS.has(token)
  }
  return false
}
