import type {
  AgentExitRetirementCondition,
  AgentExitRetirementDisposition
} from './agent-exit-retirement'
import type { RuntimeSessionTabChatView } from './runtime-session-contracts'

/** Clients treat this as delivery-unknown: the renderer may still have applied the pair. */
export const TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR = 'chat_view_relay_timeout'
/** The renderer has no locally owned tab to apply the pair to. */
export const TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR = 'tab_not_found'

export type TerminalChatViewRequest = {
  requestId: string
  worktreeId: string
  /** The desktop terminal tab id (the host parent tab). */
  tabId: string
  /** The addressed leaf, or null when the write named the parent tab. */
  leafId: string | null
  viewMode: 'terminal' | 'chat'
  /** The host's owner for a parent-addressed chat, used only when the tab holds no valid owner;
   *  null: no pane of a split may own chat. */
  ownerPickLeafId?: string | null
  /** An agent exit in `leafId`: retire that pane's chat and a sole pane's launch hint only while
   *  the condition holds (bound PTY, no newer presentation). Never moves chat elsewhere. */
  agentExit?: Omit<AgentExitRetirementCondition, 'leafId'>
}

export type TerminalChatViewResponse = {
  requestId: string
  chatView?: RuntimeSessionTabChatView
  /** For an `agentExit` request: what the renderer's conditional retirement did. */
  agentExitDisposition?: AgentExitRetirementDisposition
  error?: string
}
