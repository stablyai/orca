import type { PromptRow } from '../../agent-status/contracts/agent-pending-prompt'
import { hookRowAgentPhase } from '../../agent-status/lifecycle/agent-transitions'
import { parseAskFromStatus } from '../../native-chat/input/native-chat-ask'

/** Coarse kind only: question text, options and tool input never reach plugins. */
export function readPluginPromptKind(row: PromptRow): 'question' | undefined {
  if (hookRowAgentPhase(row) !== 'needs-you') {
    return undefined
  }
  return parseAskFromStatus(row.interactivePrompt, row.toolName) ? 'question' : undefined
}
