import { isAnteHeadlessOneShotCommand } from './ante-headless-command'
import { isPrimeAgentHeadlessOneShotCommand } from './prime-agent-headless-command'
import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'
import { isInteractiveFxCommand } from './fx-command-mode'
import type { TuiAgent } from './tui-agent'

// Why: a table (not an if-chain) so adding an agent is one entry; Claude and Trae share
// the same `--print` one-shot contract, Ante's `--prompt` form and Prime Agent's
// `--mode` forms need their own matchers.
const HEADLESS_ONE_SHOT_MATCHERS: Partial<
  Record<TuiAgent, (tokens: readonly string[]) => boolean>
> = {
  claude: isPrintModeHeadlessOneShotCommand,
  trae: isPrintModeHeadlessOneShotCommand,
  'prime-agent': isPrimeAgentHeadlessOneShotCommand,
  ante: isAnteHeadlessOneShotCommand
}

const INTERACTIVE_COMMAND_MATCHERS: Partial<
  Record<TuiAgent, (tokens: readonly string[]) => boolean>
> = {
  fx: isInteractiveFxCommand
}

export function isHeadlessOneShotAgentCommand(agent: TuiAgent, tokens: readonly string[]): boolean {
  return HEADLESS_ONE_SHOT_MATCHERS[agent]?.(tokens) ?? false
}

function isNonInteractiveAgentCommand(agent: TuiAgent, tokens: readonly string[]): boolean {
  return (
    isHeadlessOneShotAgentCommand(agent, tokens) ||
    INTERACTIVE_COMMAND_MATCHERS[agent]?.(tokens) === false
  )
}

type AgentCommandRecognition = { agent: TuiAgent } | null

export function filterNonInteractiveAgentCommand<T extends AgentCommandRecognition>(
  recognition: T,
  tokens: readonly string[]
): T | null {
  if (recognition && isNonInteractiveAgentCommand(recognition.agent, tokens)) {
    return null
  }
  return recognition
}
