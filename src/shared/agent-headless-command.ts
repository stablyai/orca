import { isAnteHeadlessOneShotCommand } from './ante-headless-command'
import { isMuseHeadlessOneShotCommand } from './muse-headless-command'
import { isDsbHeadlessOneShotCommand } from './dsb-headless-command'
import { isZCodeHeadlessOneShotCommand } from './zcode-headless-command'
import { isPrimeAgentHeadlessOneShotCommand } from './prime-agent-headless-command'
import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'
import type { TuiAgent } from './tui-agent'

// Why: a table (not an if-chain) so adding an agent is one entry; Claude and Trae share
// the same `--print` one-shot contract, Ante's `--prompt` form, Prime Agent's
// `--mode` forms, Muse's `exec` subcommand, and ZCode's `--prompt`/`--target` forms need
// their own matchers.
const HEADLESS_ONE_SHOT_MATCHERS: Partial<
  Record<TuiAgent, (tokens: readonly string[]) => boolean>
> = {
  claude: isPrintModeHeadlessOneShotCommand,
  trae: isPrintModeHeadlessOneShotCommand,
  'prime-agent': isPrimeAgentHeadlessOneShotCommand,
  ante: isAnteHeadlessOneShotCommand,
  muse: isMuseHeadlessOneShotCommand,
  zcode: isZCodeHeadlessOneShotCommand,
  dsb: isDsbHeadlessOneShotCommand
}

export function isHeadlessOneShotAgentCommand(agent: TuiAgent, tokens: readonly string[]): boolean {
  return HEADLESS_ONE_SHOT_MATCHERS[agent]?.(tokens) ?? false
}

type AgentCommandRecognition = { agent: TuiAgent } | null

export function filterHeadlessOneShotAgentCommand<T extends AgentCommandRecognition>(
  recognition: T,
  tokens: readonly string[]
): T | null {
  if (recognition && isHeadlessOneShotAgentCommand(recognition.agent, tokens)) {
    return null
  }
  return recognition
}
