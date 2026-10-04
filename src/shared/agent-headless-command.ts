import { isReasonixNonInteractiveCommand } from './reasonix-noninteractive-command'
import { isCodebuddyNonInteractiveCommand } from './codebuddy-headless-command'
import { isQoderHeadlessCommand } from './qoder-headless-command'
import { isAnteHeadlessOneShotCommand } from './ante-headless-command'
import { isDshNonInteractiveCommand } from './dsh-launch-command'
import { isMuseHeadlessOneShotCommand } from './muse-headless-command'
import { isDsbHeadlessOneShotCommand } from './dsb-headless-command'
import { isZCodeHeadlessOneShotCommand } from './zcode-headless-command'
import { isPrimeAgentHeadlessOneShotCommand } from './prime-agent-headless-command'
import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'
import type { TerminalAgent } from './terminal-agent'

// Why: a table (not an if-chain) so adding an agent is one entry; Claude and Trae share
// the same `--print` one-shot contract, Ante's `--prompt` form, Prime Agent's
// `--mode` forms, Muse's `exec` subcommand, and ZCode's `--prompt`/`--target` forms need
// their own matchers. DSH's entry is wider than a one-shot: `dsh` also boots a web server
// and JSON-RPC stdio profiles, and none of those can answer a prompt in the pane either,
// which is what this table gates.
const HEADLESS_ONE_SHOT_MATCHERS: Partial<
  Record<TerminalAgent, (tokens: readonly string[]) => boolean>
> = {
  qoder: isQoderHeadlessCommand,
  'qoder-cn': isQoderHeadlessCommand,
  claude: isPrintModeHeadlessOneShotCommand,
  codebuddy: isCodebuddyNonInteractiveCommand,
  trae: isPrintModeHeadlessOneShotCommand,
  'prime-agent': isPrimeAgentHeadlessOneShotCommand,
  ante: isAnteHeadlessOneShotCommand,
  muse: isMuseHeadlessOneShotCommand,
  zcode: isZCodeHeadlessOneShotCommand,
  reasonix: isReasonixNonInteractiveCommand,
  dsh: isDshNonInteractiveCommand,
  dsb: isDsbHeadlessOneShotCommand
}

export function isHeadlessOneShotAgentCommand(
  agent: TerminalAgent,
  tokens: readonly string[]
): boolean {
  return HEADLESS_ONE_SHOT_MATCHERS[agent]?.(tokens) ?? false
}

type AgentCommandRecognition = { agent: TerminalAgent } | null

export function filterHeadlessOneShotAgentCommand<T extends AgentCommandRecognition>(
  recognition: T,
  tokens: readonly string[]
): T | null {
  if (recognition && isHeadlessOneShotAgentCommand(recognition.agent, tokens)) {
    return null
  }
  return recognition
}
