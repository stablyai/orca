const FX_OPTIONS_WITH_VALUE = new Set(['--context-limit', '--add-dir'])
const FX_EXIT_OPTIONS = new Set(['-h', '--help', '-v', '--version'])

function executableName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

export function isInteractiveFxCommand(tokens: readonly string[]): boolean {
  const executableIndex = tokens.findIndex((token) => executableName(token) === 'fx')
  if (executableIndex === -1) {
    return false
  }

  const args = tokens.slice(executableIndex + 1)
  const positional: string[] = []
  let resume = false
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.toLowerCase() ?? ''
    if (FX_EXIT_OPTIONS.has(token) || token === '--') {
      return false
    }
    if (FX_OPTIONS_WITH_VALUE.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('--context-limit=') || token.startsWith('--add-dir=')) {
      continue
    }
    if (token === '--resume') {
      resume = true
      const resumeTarget = args[index + 1]
      if (resumeTarget && !resumeTarget.startsWith('-')) {
        index += 1
      }
      continue
    }
    if (
      token === '-c' ||
      token === '--continue' ||
      token === '-r' ||
      token.startsWith('--resume-')
    ) {
      resume = true
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    positional.push(token)
  }
  if (resume) {
    return positional.length === 0
  }
  if (positional.length === 0) {
    return true
  }
  return positional.length <= 3 && positional[0] === 'session' && positional[1] === 'resume'
}
