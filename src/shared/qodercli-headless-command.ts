import { isPrintModeHeadlessOneShotCommand, optionName } from './print-mode-headless-command'

const HEADLESS_OUTPUT_FORMATS = new Set(['json', 'stream-json'])

function optionValue(tokens: readonly string[], index: number): string | null {
  const token = tokens[index]
  const eq = token.indexOf('=')
  if (eq !== -1) {
    return token.slice(eq + 1)
  }
  return tokens[index + 1] ?? null
}

// Why: qodercli shares Claude's `--print`/`-p` and `--output-format` contract, but adds two forms
// the shared matcher doesn't know: the short `-o` alias, and `--input-format stream-json`, which
// forces headless mode on its own (`config.ts` isHeadlessMode). Kept in a qodercli-specific matcher
// so `-o` doesn't change how Claude and Trae command lines are classified.
export function isQoderCliHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  if (isPrintModeHeadlessOneShotCommand(tokens)) {
    return true
  }
  for (let index = 1; index < tokens.length; index += 1) {
    // Why: `--` ends option parsing, so a prompt that reads like `-o json` is still a prompt.
    if (tokens[index] === '--') {
      return false
    }
    const name = optionName(tokens[index])
    if (name === '-o') {
      const value = optionValue(tokens, index)?.toLowerCase()
      if (value && HEADLESS_OUTPUT_FORMATS.has(value)) {
        return true
      }
    }
    if (name === '--input-format') {
      if (optionValue(tokens, index)?.toLowerCase() === 'stream-json') {
        return true
      }
    }
  }
  return false
}
