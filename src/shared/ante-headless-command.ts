import { isPromptFlagHeadlessOneShotCommand } from './prompt-flag-headless-command'

export function isAnteHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return isPromptFlagHeadlessOneShotCommand(tokens)
}
