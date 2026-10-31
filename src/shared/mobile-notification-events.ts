import type { AgentStatusState } from './agent-status-types'
import type { StructuredAttentionOrigin } from './agent-session-attention'

export type MobileNotificationDispatchEvent = {
  type: 'notification'
  legacySocketAllowed?: boolean
  desktopAllowed?: boolean
  desktopAway?: boolean
  emittedAt?: number
  source: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  title: string
  body: string
  worktreeId?: string
  /** The pane the phone opens on tap; old phones ignore it and open the workspace's default tab. */
  paneKey?: string
  /** See `NotificationDispatchRequest.executionHost`; old phones ignore it and open the desktop's. */
  executionHost?: `runtime:${string}`
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  // Additive state distinguishes input-needed from finished in push; old clients ignore it.
  agentState?: AgentStatusState
  /** See `NotificationDispatchRequest.attentionKey`: cooldowns key on it instead of the workspace. */
  attentionKey?: string
  structuredOrigin?: StructuredAttentionOrigin
}
