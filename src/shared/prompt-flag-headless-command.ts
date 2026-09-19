import { optionName } from './print-mode-headless-command'

const HEADLESS_PROMPT_FLAGS = new Set(['--prompt', '-p'])

export function isPromptFlagHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index])
    if (HEADLESS_PROMPT_FLAGS.has(name) || /^-p[^-]/.test(name)) {
      return true
    }
  }
  return false
}
