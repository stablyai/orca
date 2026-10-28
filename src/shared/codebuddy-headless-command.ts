import { agentArgOptionTokens } from './agent-session-option-agent-args'
import { isPrintModeHeadlessOneShotCommand, optionName } from './print-mode-headless-command'

const NON_INTERACTIVE_FLAGS = new Set(['--serve', '--acp', '--bg', '--background'])

export function isCodebuddyNonInteractiveCommand(tokens: readonly string[]): boolean {
  return (
    isPrintModeHeadlessOneShotCommand(tokens) ||
    agentArgOptionTokens(tokens)
      .slice(1)
      .some((token) => NON_INTERACTIVE_FLAGS.has(optionName(token)))
  )
}
