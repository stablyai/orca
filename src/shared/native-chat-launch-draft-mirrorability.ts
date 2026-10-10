import { AGENT_TUI_CLEAR_MAX_LINES, countAgentTuiInputLines } from './agent-tui-input-clear'

/**
 * Single source of truth for whether unsent launch context can be mirrored from
 * the agent's TUI input into the native-chat composer.
 *
 * Explicit terminal chat view can mirror a launch draft only when the TUI input
 * can be cleared within the same bound.
 *
 * CR/LF drafts are safe within the bounded TUI-clear budget. Unicode line
 * separators and drafts beyond that budget remain terminal-only.
 */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !/[\u2028\u2029]/.test(text) &&
    countAgentTuiInputLines(text) <= AGENT_TUI_CLEAR_MAX_LINES
  )
}
