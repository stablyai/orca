import { AGENT_TUI_CLEAR_MAX_LINES, countAgentTuiInputLines } from './agent-tui-input-clear'

/** Mirror launch context only if TUI input can be cleared within the same budget. CR/LF fit the bound; Unicode separators/over-budget drafts stay terminal-only. */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !/[\u2028\u2029]/.test(text) &&
    countAgentTuiInputLines(text) <= AGENT_TUI_CLEAR_MAX_LINES
  )
}
