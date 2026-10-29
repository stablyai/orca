/** The host publishes/resolves a launch tab under its IDs before spawning; the window places its pending pane and returns placement. */

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
  /** Main-owned layout: draw the existing tab at frameSeq, retain pane/prompt/presentation, and apply viewer rules only if this launch created it. */
  shownByMain?: { frameSeq?: number; created: boolean }
}

export type AgentLaunchTabPublishReply =
  | {
      requestId: string
      tabId: string
      /** True for a tab created by this launch (including just before request); false for retries finding it. */
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
