/** `agent launch --split`: a launched chat opens in a new pane beside the calling chat instead of as a tab. */

import { z } from 'zod'
import type { AgentLaunchPlacementReceipt } from './agent-launch-intent'

export const AgentLaunchSplitParam = z.object({
  direction: z.enum(['right', 'down']),
  /** A placement hint from the CLI (`ORCA_AGENT_SESSION_ID`); absent or stale, the active pane anchors. */
  fromSessionId: z.string().min(1).optional()
})

export type AgentLaunchSplit = z.infer<typeof AgentLaunchSplitParam>

/** `activate` false keeps the focused pane; past `expiresAt` the window must not move anything. */
export type AgentLaunchSplitRequest = {
  requestId: string
  worktreeId: string
  sessionId: string
  split: AgentLaunchSplit
  activate: boolean
  expiresAt: number
}

export type AgentLaunchSplitReply = { requestId: string; placement: AgentLaunchPlacementReceipt }
