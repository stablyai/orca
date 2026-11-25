import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'

// Only text mode hosts the TUI. Prime parses --mode plus a separate json/rpc/acp/daemon token; --mode=json remains interactive.
const NON_INTERACTIVE_MODES = new Set(['json', 'rpc', 'acp', 'daemon'])

export function isPrimeAgentHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  if (isPrintModeHeadlessOneShotCommand(tokens)) {
    return true
  }
  for (let index = 1; index < tokens.length; index += 1) {
    // Why: `--` ends option parsing, so a prompt that reads like `--mode` is still a prompt.
    if (tokens[index] === '--') {
      return false
    }
    if (tokens[index] === '--mode' && NON_INTERACTIVE_MODES.has(tokens[index + 1] ?? '')) {
      return true
    }
  }
  return false
}
