import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'

// Why: Prime Agent's non-interactive runs are `--mode <json|rpc|acp|daemon>` as well as
// `--print`; only `text` hosts the TUI. Matching upstream, the value must be a separate
// token — `--mode=json` is not parsed by the CLI, so it still starts the interactive mode.
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
