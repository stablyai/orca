import type { RuntimeTerminalPromptDelivery } from './runtime-terminal-send-contract'

/** Observed/permission prove live input handling; unsupported keeps accepted-write evidence.
 * Unobserved means supported observation timed out after write: unverifiable, never dead, and no safe blind resend. */
export type TerminalPromptTurnStart = 'observed' | 'permission' | 'unsupported' | 'unobserved'

export function classifyTerminalPromptTurnStart(
  prompt: RuntimeTerminalPromptDelivery
): TerminalPromptTurnStart {
  if (prompt.stages.includes('turn_started')) {
    return 'observed'
  }
  if (prompt.observation === 'permission') {
    return 'permission'
  }
  if (prompt.observation === 'supported') {
    return 'unobserved'
  }
  // 'unsupported' (and an old host's missing observation) leaves acceptance as the best receipt.
  return 'unsupported'
}
