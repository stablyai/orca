import { isPrintModeHeadlessOneShotCommand, optionName } from './print-mode-headless-command'

export function isQoderHeadlessCommand(tokens: readonly string[]): boolean {
  if (isPrintModeHeadlessOneShotCommand(tokens)) {
    return true
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return false
    }
    const name = optionName(token)
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[index + 1]
    if (name === '-o' && (value === 'json' || value === 'stream-json')) {
      return true
    }
    if (name === '--input-format' && value === 'stream-json') {
      return true
    }
    if (
      name === '--remote-control' ||
      name === '--remote' ||
      name === '--list-sessions' ||
      name === '--delete-session' ||
      name === '--acp'
    ) {
      return true
    }
  }
  return false
}
