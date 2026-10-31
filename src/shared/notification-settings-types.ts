import type { StructuredAttentionRead, StructuredAttentionOrigin } from './agent-session-attention'
import type { AgentStatusState, AgentType } from './agent-status-types'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import type { NotificationSourceId } from './notification-source'

export type NotificationSettings = {
  enabled: boolean
  agentTaskComplete: boolean
  terminalBell: boolean
  suppressWhenFocused: boolean
  /** macOS Dock icon unread badge; hiding it must not touch in-app unread state. */
  showDockBadge: boolean
  customSoundId:
    | 'system'
    | 'two-tone'
    | 'bong'
    | 'thump'
    | 'blip'
    | 'sonar'
    | 'blop'
    | 'ding'
    | 'clack'
    | 'beep'
    | 'custom'
  customSoundPath: string | null
  customSoundVolume: number
  /** Desktop opt-outs stored only on this client, per configured source and work reached through it; new sources notify. */
  mutedNotificationSourceIds: NotificationSourceId[]
  /** Off silences every notification from a workspace the sidebar's Filters switches hide. Local only. */
  notifyHiddenWorkspaces: boolean
}

export type NotificationEventSource = 'agent-task-complete' | 'terminal-bell' | 'test'

export type StructuredNotificationRead = StructuredAttentionRead & {
  paneKey: string
}

export type NotificationDispatchRequest = {
  source: NotificationEventSource
  notificationId?: string
  /** Why: useful for fast native failures, but macOS can still drop notifications after 'show'. */
  requireDisplayConfirmation?: boolean
  worktreeId?: string
  /** Configured notification source; independent of physical execution location. */
  notificationSourceId?: NotificationSourceId
  /** The server the workspace runs on, so a paired phone opens it there; absent for this desktop's own work. */
  executionHost?: `runtime:${string}`
  /** Stable `${tabId}:${leafId}` terminal pane key for click-to-focus routing. */
  paneKey?: string
  repoLabel?: string
  worktreeLabel?: string
  /** Legacy senders may still provide this; project labels are now always shown. */
  hasMultipleActiveRepos?: boolean
  terminalTitle?: string
  isActiveWorktree?: boolean
  agentType?: AgentType
  agentState?: AgentStatusState
  agentPrompt?: string
  agentToolName?: string
  agentToolInput?: string
  agentLastAssistantMessage?: string
  /** The verdict on the turn this notification reports, which picks its wording. */
  agentTurnOutcome?: AgentTurnOutcome
  /** Click-routing lane; absence means terminal, preserving pre-structured-chat senders. */
  surface?: 'terminal' | 'agent-session'
  /** Producer-owned once-only news identity bypasses workspace burst dedupe so distinct events survive. */
  attentionKey?: string
  structuredOrigin?: StructuredAttentionOrigin
  /** The execution host already pushed this to its paired phones, so main must not fan it out again. */
  mobileDeliveredByHost?: boolean
}

export type NotificationDispatchResult = {
  delivered: boolean
  /** Why delivery was skipped (set when delivered is false); 'blocked-by-system' = macOS would silently swallow it. */
  reason?:
    | 'disabled'
    | 'source-disabled'
    | 'host-muted'
    | 'suppressed-focus'
    | 'cooldown'
    | 'not-supported'
    | 'not-displayed'
    | 'blocked-by-system'
    | 'invalid-request'
}

export type NotificationDismissResult = {
  dismissed: number
}

export type NotificationSoundResult = {
  played: boolean
  reason?:
    | 'missing-path'
    | 'invalid-path'
    | 'unsupported-type'
    | 'too-large'
    | 'read-failed'
    | 'playback-failed'
    | 'deduped'
}

export type NotificationSoundDataResult =
  | {
      ok: true
      data: Uint8Array
      mimeType: string
      path: string
    }
  | {
      ok: false
      reason: Exclude<NotificationSoundResult['reason'], 'playback-failed'>
    }

export type NotificationSoundPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing-path' | 'invalid-path' | 'unsupported-type' }

export type NotificationPermissionStatusResult = {
  supported: boolean
  platform: NodeJS.Platform
  requested: boolean
}

/** macOS permission from authoritative native UNUserNotificationCenter, otherwise weaker delivery probing; awaiting-decision means unanswered dialog. */
export type NotificationDeliveryProbeResult = {
  state: 'delivered' | 'blocked' | 'awaiting-decision' | 'unsupported'
  /** True when the state comes from the native authorization readout (vs. the delivery-probe fallback). */
  authoritative: boolean
}
