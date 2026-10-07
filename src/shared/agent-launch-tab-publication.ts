/**
 * The host asking the window that owns a workspace's tab layout to show an agent launch's tab before
 * the agent exists. The window creates the tab under the host's ids (or finds the one it already
 * made under them), lays out its one pane, and replies with where it landed. The pane then waits
 * for the host's process; see `agent-launch-pane-attachment`.
 */

import type { AgentLaunchPlacement, AgentLaunchPlacementReceipt } from './agent-launch-intent'
import type { TuiAgent } from './tui-agent'

/**
 * Whose screen moves, decided on the host from who called. Mirrors the browser-tab split between
 * the host's view and a caller's own: a paired device never moves the host window.
 *
 * - `focus-window`: the window goes to the workspace and the tab (the CLI asked for focus).
 * - `focus-in-workspace`: the tab becomes the workspace's active tab; the window switches to it only
 *   if it is already on that workspace (the desktop asked, then may have moved on).
 * - `reveal-owner`: today's unfocused agent.launch reveal (workspace shown in the sidebar).
 * - `none`: the tab is created in place; nothing moves.
 */
export type AgentLaunchTabViewerRule =
  | 'focus-window'
  | 'focus-in-workspace'
  | 'reveal-owner'
  | 'none'

export type AgentLaunchTabPublishRequest = {
  requestId: string
  worktreeId: string
  tabId: string
  leafId: string
  launchAgent: TuiAgent
  viewMode: 'terminal' | 'chat'
  placement?: AgentLaunchPlacement
  viewer: AgentLaunchTabViewerRule
  /** The launch's prompt, so a pane whose agent did not start can offer to copy it. */
  prompt?: string
  /** Which launch this is: a retry of the same one never resets what the tab keeps about it. */
  operationId?: string
}

export type AgentLaunchTabPublishReply =
  | {
      requestId: string
      tabId: string
      /** True when the tab exists only for this launch: the window made it now, or made it for this
       *  launch just before asking (a desktop launch). False for a retry that found the tab. */
      created: boolean
      placement: AgentLaunchPlacementReceipt
    }
  | { requestId: string; error: string }

/** The reply as the host reads it. */
export type AgentLaunchTabPublished = {
  tabId: string
  created: boolean
  placement: AgentLaunchPlacementReceipt
}
