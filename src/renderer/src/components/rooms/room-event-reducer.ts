import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomEvent,
  RoomMessage,
  RoomSnapshot
} from '../../../../shared/rooms'

export type ActiveRoomState = {
  snapshot: RoomSnapshot | null
  messages: RoomMessage[]
  deliveries: Record<string, RoomDelivery>
  activities: Record<string, RoomAgentActivity>
}

export const EMPTY_ACTIVE_ROOM: ActiveRoomState = {
  snapshot: null,
  messages: [],
  deliveries: {},
  activities: {}
}

export type RoomStateAction =
  | RoomEvent
  | { type: 'local.reset' }
  | { type: 'local.messages.cleared' }
  | { type: 'local.messages.loaded'; messages: RoomMessage[]; deliveries: RoomDelivery[] }

export function reduceRoomEvent(state: ActiveRoomState, event: RoomStateAction): ActiveRoomState {
  if (event.type === 'local.reset') {
    return EMPTY_ACTIVE_ROOM
  }
  if (event.type === 'local.messages.cleared') {
    return { ...state, messages: [], deliveries: {} }
  }
  if (event.type === 'local.messages.loaded') {
    return {
      ...state,
      messages: mergeMessages(event.messages, state.messages),
      deliveries: Object.fromEntries(
        [...Object.values(state.deliveries), ...event.deliveries].map((delivery) => [
          delivery.id,
          delivery
        ])
      )
    }
  }
  if (event.type === 'snapshot') {
    return {
      ...state,
      snapshot: event.snapshot,
      activities: Object.fromEntries(
        event.snapshot.activities.map((activity) => [activity.participantId, activity])
      )
    }
  }
  if (event.type === 'message.created' || event.type === 'message.updated') {
    const exists = state.messages.some((message) => message.id === event.message.id)
    const next = {
      ...state,
      messages: upsert(state.messages, event.message),
      activities:
        event.type === 'message.created' && event.message.actorKind === 'agent'
          ? withoutKey(state.activities, event.message.senderId ?? '')
          : state.activities
    }
    if (event.type === 'message.updated' || exists || !state.snapshot) {
      return next
    }
    return {
      ...next,
      snapshot: {
        ...state.snapshot,
        unread: { ...state.snapshot.unread, unreadCount: state.snapshot.unread.unreadCount + 1 }
      }
    }
  }
  if (event.type === 'message.deleted') {
    return {
      ...state,
      messages: state.messages.map((message) =>
        message.id === event.messageId ? { ...message, body: '', deletedAt: Date.now() } : message
      )
    }
  }
  if (event.type === 'delivery.updated') {
    return {
      ...state,
      deliveries: { ...state.deliveries, [event.delivery.id]: event.delivery },
      snapshot:
        state.snapshot && event.workState
          ? { ...state.snapshot, workState: event.workState }
          : state.snapshot
    }
  }
  if (event.type === 'activity.updated') {
    return {
      ...state,
      activities: { ...state.activities, [event.activity.participantId]: event.activity }
    }
  }
  if (event.type === 'activity.cleared') {
    return { ...state, activities: withoutKey(state.activities, event.participantId) }
  }
  if (!state.snapshot) {
    return state
  }
  const snapshot = state.snapshot
  switch (event.type) {
    case 'room.updated':
      return { ...state, snapshot: { ...snapshot, room: event.room } }
    case 'role.updated':
      return { ...state, snapshot: { ...snapshot, roles: upsert(snapshot.roles, event.role) } }
    case 'role.removed':
      return removeFromSnapshot(state, 'roles', event.roleId)
    case 'participant.updated':
      return {
        ...state,
        snapshot: { ...snapshot, participants: upsert(snapshot.participants, event.participant) }
      }
    case 'participant.removed':
      return {
        ...removeFromSnapshot(state, 'participants', event.participantId),
        activities: withoutKey(state.activities, event.participantId)
      }
    case 'pin.updated': {
      const pins = snapshot.pins.filter((pin) => pin.messageId !== event.messageId)
      return { ...state, snapshot: { ...snapshot, pins: event.pin ? [...pins, event.pin] : pins } }
    }
    case 'unread.updated':
      return { ...state, snapshot: { ...snapshot, unread: event.unread } }
    case 'end':
      return state
  }
}

function withoutKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([candidate]) => candidate !== key))
}

function mergeMessages(first: RoomMessage[], second: RoomMessage[]): RoomMessage[] {
  const merged = new Map(first.map((message) => [message.id, message]))
  for (const message of second) {
    merged.set(message.id, message)
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
}

function upsert<T extends { id: string }>(items: T[], item: T, key: keyof T = 'id'): T[] {
  const index = items.findIndex((value) => value[key] === item[key])
  if (index === -1) {
    const next = [...items, item]
    if ('sequence' in item) {
      next.sort(
        (left, right) =>
          Number((left as { sequence?: number }).sequence ?? 0) -
          Number((right as { sequence?: number }).sequence ?? 0)
      )
    }
    return next
  }
  const next = [...items]
  next[index] = item
  return next
}

function removeFromSnapshot(
  state: ActiveRoomState,
  key: 'roles' | 'participants',
  id: string
): ActiveRoomState {
  const snapshot = state.snapshot!
  return {
    ...state,
    snapshot: { ...snapshot, [key]: snapshot[key].filter((item) => item.id !== id) }
  }
}
