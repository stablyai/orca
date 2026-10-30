import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { NativeChatRewindHost } from './use-native-chat-rewind'

export type StructuredAgentSessionViewArgs = {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  transportEnabled?: boolean
  /** The host has published the session but its provider has not answered startup yet. */
  providerStarting?: boolean
  /** The host runs the session's provider and its start is proven. */
  providerRunning?: boolean
  /** This view started the session; only then does the stored selection name what it runs. */
  launch?: StructuredAgentSessionLaunchView
  /** Composer destination for preserved text from queued-card edits. */
  composerScopeKey?: string
  /** The chat-wide "queue follow-ups" setting; off keeps mid-turn sends immediate. */
  queueFollowUps?: boolean
  /** The host says a person's Stop is still ending this session's work. */
  hostStopping?: boolean
  /** The option values the host's status carries; a change re-reads the chat's options. */
  hostOptionStamp?: string
  /** The host's rewind latch and what follows a message returned by a rewind. */
  rewind?: NativeChatRewindHost
}
