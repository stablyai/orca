import {
  AGENT_TUI_CLEAR_MAX_LINES,
  countAgentTuiInputLines
} from '../../../shared/agent-tui-input-clear'

/**
 * Single source of truth for whether unsent launch context can be mirrored from
 * the agent's TUI input into the native-chat composer.
 *
 * Both the seeding path (`seedNativeChatLaunchDraftForAgentTab`) and the
 * initial-view-mode decision (`decideInitialAgentTabViewMode`) gate on this one
 * predicate, so a draft launch can never open in chat with a composer that
 * chat then refuses to fill.
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
