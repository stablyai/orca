import type { NativeChatMessage } from './native-chat-types'
import type {
  AgentSessionCompactionState,
  AgentSessionContextSnapshot
} from './agent-session-context'

export const ROOM_HARNESS_AGENTS = ['claude', 'openclaude', 'codex', 'grok'] as const
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
  archivedAt: number | null
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
  participation: RoomParticipation
  state: RoomParticipantState
  context: RoomContextSnapshot
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
}

export type RoomAttachableAgent = {
  agent: RoomHarnessAgent
  worktreeId: string
  terminalHandle: string
  paneKey: string
  title: string | null
  providerSession: RoomProviderSession | null
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

export type RoomSnapshot = {
  room: Room
  participants: RoomParticipant[]
  activities: RoomAgentActivity[]
  roles: RoomRole[]
  pins: RoomPin[]
  unread: RoomUnread
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
  | { type: 'delivery.updated'; delivery: RoomDelivery }
  | { type: 'room.updated'; room: Room }
  | { type: 'role.updated'; role: RoomRole }
  | { type: 'role.removed'; roleId: string }
  | { type: 'participant.updated'; participant: RoomParticipant }
  | { type: 'participant.removed'; participantId: string }
  | { type: 'activity.updated'; activity: RoomAgentActivity }
  | { type: 'activity.cleared'; participantId: string }
  | { type: 'pin.updated'; pin: RoomPin | null; messageId: string }
  | { type: 'unread.updated'; unread: RoomUnread }
  | { type: 'end' }

export { EMPTY_ROOM_CONTEXT } from './room-context'
