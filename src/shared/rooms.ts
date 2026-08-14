import type { NativeChatMessage } from './native-chat-types'
import type {
  StructuredProviderInput,
  StructuredProviderPermission
} from './structured-agent-provider'
import type {
  AgentSessionCompactionState,
  AgentSessionContextSnapshot
} from './agent-session-context'

export const ROOM_HARNESS_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'omp'] as const
export type RoomHarnessAgent = (typeof ROOM_HARNESS_AGENTS)[number]
export type RoomActorKind = 'user' | 'agent' | 'system'
export type RoomParticipantState = 'starting' | 'online' | 'busy' | 'sleeping' | 'offline' | 'error'
export type RoomParticipation = 'active' | 'paused'
export type RoomActivityKind =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'command'
  | 'web'
  | 'working'
export type RoomAgentActivity = {
  participantId: string
  identity: string
  state: 'working' | 'failed' | 'interrupted'
  kind: RoomActivityKind
  detail?: string
  permission?: StructuredProviderPermission
  input?: StructuredProviderInput
  messages: NativeChatMessage[]
  startedAt: number
  updatedAt: number
  anchorSequence: number | null
}
export type RoomCompletedActivity = {
  state: 'completed'
  messages: NativeChatMessage[]
  startedAt: number
  completedAt: number
}
export type RoomCompactionState = AgentSessionCompactionState
export type RoomPinStatus = 'todo' | 'done'
export type RoomProviderSession = {
  key: 'session_id' | 'conversation_id'
  id: string
  transcriptPath?: string
  transport?: 'machine'
  sourceSessionId?: string
}
export type RoomContextSnapshot = AgentSessionContextSnapshot
export type Room = {
  id: string
  projectId: string
  worktreeId: string | null
  name: string
  description: string
  loopLimit: number
  createdAt: number
  updatedAt: number
}
export type RoomRole = {
  id: string
  roomId: string
  name: string
  prompt: string
  isPreset: boolean
  createdAt: number
  updatedAt: number
}

export type RoomParticipant = {
  id: string
  roomId: string
  identity: string
  displayName: string
  actorKind: Exclude<RoomActorKind, 'system'>
  agent: RoomHarnessAgent | null
  roleId: string | null
  worktreeId: string | null
  paneKey: string | null
  terminalHandle: string | null
  providerSession: RoomProviderSession | null
  /** Runtime process identity the room last bound to; a mismatch on restore
   *  means the harness process was restarted and must prove readiness again. */
  processIncarnation: string | null
  /** Whether the agent terminal was explicitly promoted into the user's tab strip. */
  terminalSurfaceVisible?: boolean
  participation: RoomParticipation
  state: RoomParticipantState
  context: RoomContextSnapshot
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
}

export type RoomRunningAgent = {
  agent: RoomHarnessAgent
  worktreeId: string
  terminalHandle: string
  paneKey: string
  title: string | null
  providerSession: RoomProviderSession | null
}

export type RoomExistingAgentCandidate = {
  id: string
  agent: RoomHarnessAgent
  title: string | null
  status: 'running' | 'history'
  model: string | null
  updatedAt: string | null
  providerSession: RoomProviderSession | null
  terminalHandle?: string
  paneKey?: string
  historyId?: string
  conversationId?: string
}

export type RoomAttachment = {
  id: string
  messageId: string
  fileName: string
  mimeType: string
  byteSize: number
  localPath: string
  createdAt: number
}

export type RoomMessage = {
  id: string
  roomId: string
  sequence: number
  senderId: string | null
  senderIdentity: string
  actorKind: RoomActorKind
  kind: 'chat' | 'system' | 'decision' | 'proposal'
  body: string
  replyToId: string | null
  rootMessageId: string | null
  hopCount: number
  metadata: Record<string, unknown>
  mentions: string[]
  attachments: RoomAttachment[]
  createdAt: number
  editedAt: number | null
  deletedAt: number | null
}

export type RoomPin = {
  roomId: string
  messageId: string
  status: RoomPinStatus
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type RoomUnread = {
  roomId: string
  unreadCount: number
  lastReadSequence: number
}

export type RoomWorkState = 'idle' | 'active' | 'stopped'

export type RoomSnapshot = {
  room: Room
  participants: RoomParticipant[]
  activities: RoomAgentActivity[]
  roles: RoomRole[]
  pins: RoomPin[]
  unread: RoomUnread
  /** Absent when connected to a host that predates room Stop/Resume. */
  workState?: RoomWorkState
}

export type RoomMessagePage = {
  messages: RoomMessage[]
  deliveries: RoomDelivery[]
  hasMore: boolean
  beforeSequence: number | null
}

export type RoomDelivery = {
  id: string
  messageId: string
  participantId: string
  state: 'pending' | 'delivering' | 'delivered' | 'failed' | 'suppressed'
  attempts: number
  error: string | null
  nextAttemptAt: number
  deliveredAt: number | null
  providerTurnId: string | null
  responseMessageId: string | null
  respondedAt: number | null
  phase?: 'waking' | 'submitting' | 'awaiting-turn' | null
  attemptHistory?: RoomDeliveryAttempt[]
}

export type RoomDeliveryAttempt = {
  attempt: number
  phase: NonNullable<RoomDelivery['phase']>
  error: string
  at: number
}

export type RoomMessageNotificationContext = {
  roomName: string
  worktreeId: string | null
  paneKey: string | null
  agent: RoomHarnessAgent | null
}

export type RoomEvent =
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | {
      type: 'message.created'
      message: RoomMessage
      notification?: RoomMessageNotificationContext
    }
  | { type: 'message.updated'; message: RoomMessage }
  | { type: 'message.deleted'; messageId: string }
  | { type: 'delivery.updated'; delivery: RoomDelivery; workState?: RoomWorkState }
  | { type: 'room.updated'; room: Room }
  | { type: 'role.updated'; role: RoomRole }
  | { type: 'role.removed'; roleId: string }
  | { type: 'participant.updated'; participant: RoomParticipant }
  | { type: 'participant.removed'; participantId: string }
  | { type: 'activity.updated'; activity: RoomAgentActivity }
  | { type: 'activity.cleared'; participantId: string }
  | { type: 'pin.updated'; pin: RoomPin | null; messageId: string }
  | { type: 'unread.updated'; unread: RoomUnread }
  | { type: 'end'; reason?: 'deleted' }

export type RoomNotificationReplayPage = {
  events: Extract<RoomEvent, { type: 'message.created' }>[]
  cursor: number
  hasMore: boolean
}

export { EMPTY_ROOM_CONTEXT } from './room-context'
