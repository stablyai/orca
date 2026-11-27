import { findInterpreterEntrypointToken } from './agent-command-line-entrypoint'

/** Only an interactive Doubao session can receive a dispatch. The npm shim also runs account and service commands. */
export function isDoubaoNonInteractiveCommand(tokens: readonly string[]): boolean {
  const entrypoint = /(?:^|[\\/])node(?:\.exe)?$/i.test(tokens[0])
    ? findInterpreterEntrypointToken(tokens, 'node')
    : null
  const start = entrypoint ? tokens.indexOf(entrypoint, 1) + 1 : 1
  for (let index = start; index < tokens.length; index += 1) {
    switch (tokens[index]) {
      case '-C':
      case '--model':
      case '--effort':
      case '--permission-mode':
      case '--resume':
        if (!tokens[index + 1] || tokens[index + 1].startsWith('-')) {
          return true
        }
        index += 1
        break
      case '--dangerously-bypass-approvals-and-sandbox':
        break
      default:
        return true
    }
  }
  return false
}
