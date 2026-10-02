import {
  EMPTY_ROOM_CONTEXT,
  type Room,
  type RoomAgentActivity,
  type RoomDelivery,
  type RoomMessage,
  type RoomParticipant,
  type RoomProviderSession,
  type RoomSnapshot
} from './rooms'

export function roomActivityFixture(overrides: Partial<RoomAgentActivity> = {}): RoomAgentActivity {
  return {
    participantId: 'participant',
    identity: 'codex',
    state: 'working',
    kind: 'thinking',
    messages: [],
    startedAt: 0,
    updatedAt: 0,
    anchorSequence: null,
    ...overrides
  }
}

export function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room',
    projectId: 'project',
    worktreeId: null,
    name: 'Room',
    description: '',
    loopLimit: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

export function roomParticipantFixture(
  overrides: Omit<Partial<RoomParticipant>, 'providerSession' | 'context'> & {
    providerSession?: Partial<RoomProviderSession> | null
    context?: Partial<RoomParticipant['context']>
  } = {}
): RoomParticipant {
  return {
    id: 'participant',
    roomId: 'room',
    identity: 'codex',
    displayName: 'Codex',
    actorKind: 'agent',
    agent: 'codex',
    roleId: null,
    worktreeId: null,
    paneKey: null,
    terminalHandle: null,
    processIncarnation: null,
    participation: 'active',
    state: 'online',
    lastSeenAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
    context: { ...EMPTY_ROOM_CONTEXT, ...overrides.context },
    providerSession: overrides.providerSession
      ? { key: 'session_id', id: 'session', ...overrides.providerSession }
      : null
  }
}

export function roomMessageFixture(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: 'message',
    roomId: 'room',
    sequence: 1,
    senderId: null,
    senderIdentity: 'user',
    actorKind: 'user',
    kind: 'chat',
    body: '',
    replyToId: null,
    rootMessageId: null,
    hopCount: 0,
    metadata: {},
    mentions: [],
    attachments: [],
    createdAt: 0,
    editedAt: null,
    deletedAt: null,
    ...overrides
  }
}

export function roomDeliveryFixture(overrides: Partial<RoomDelivery> = {}): RoomDelivery {
  return {
    id: 'delivery',
    messageId: 'message',
    participantId: 'participant',
    state: 'pending',
    attempts: 0,
    error: null,
    nextAttemptAt: 0,
    deliveredAt: null,
    providerTurnId: null,
    responseMessageId: null,
    respondedAt: null,
    ...overrides
  }
}

export function roomSnapshotFixture(
  overrides: Omit<Partial<RoomSnapshot>, 'room' | 'participants' | 'unread'> & {
    room?: Partial<Room>
    participants?: Parameters<typeof roomParticipantFixture>[0][]
    unread?: Partial<RoomSnapshot['unread']>
  } = {}
): RoomSnapshot {
  return {
    activities: [],
    roles: [],
    pins: [],
    ...overrides,
    unread: { roomId: 'room', unreadCount: 0, lastReadSequence: 0, ...overrides.unread },
    room: roomFixture(overrides.room),
    participants: (overrides.participants ?? []).map(roomParticipantFixture)
  }
}
