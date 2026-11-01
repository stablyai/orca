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

// Agent-specific one-shot forms cannot accept pane prompts; DSH server/JSON-RPC modes must be excluded too.
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
