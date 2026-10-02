import type { RoomDelivery, RoomMessage, RoomParticipant } from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'

export const SHARED_ZONE_ID = 'room-queue-shared-zone'
const RETARGETED = 'room_delivery_retargeted'
const PARTICIPANT_PAUSED = 'room_participant_paused'
const FALLBACK_POSITION = Number.MAX_SAFE_INTEGER

export const sharedRowId = (messageId: string): string => `room-queue-all:${messageId}`
export const squareId = (participantId: string): string => `room-queue-square:${participantId}`
export const squareOpenId = (participantId: string): string =>
  `room-queue-square-open:${participantId}`

export const parseSharedRowId = (id: string): string | null =>
  id.startsWith('room-queue-all:') ? id.slice('room-queue-all:'.length) : null
export const parseCollapsedSquareId = (id: string): string | null =>
  id.startsWith('room-queue-square:') ? id.slice('room-queue-square:'.length) : null
export function parseSquareId(id: string): string | null {
  const collapsed = parseCollapsedSquareId(id)
  if (collapsed) {
    return collapsed
  }
  if (id.startsWith('room-queue-square-open:')) {
    return id.slice('room-queue-square-open:'.length)
  }
  return null
}

export type RoomQueueState = {
  participants: RoomParticipant[]
  shared: RoomMessage[]
  sharedPendingIds: string[]
  queueableMessageIds: string[]
  directed: Map<string, RoomDelivery[]>
  targets: Map<string, string[]>
  hasDirected: boolean
}

export type RoomMessageAudience = {
  identities: string[]
  state: 'queued' | 'steering' | 'steered' | 'paused' | 'uncertain' | 'failed' | 'directed'
}

export const isMutableDelivery = (delivery: RoomDelivery): boolean =>
  delivery.attempts === 0 &&
  (delivery.state === 'pending' ||
    (delivery.state === 'suppressed' &&
      (delivery.error === RETARGETED ||
        delivery.error === PARTICIPANT_PAUSED ||
        (delivery.error === 'room_stopped' && delivery.intent === 'next'))))
export const isQueueableDelivery = (delivery: RoomDelivery): boolean =>
  delivery.state === 'pending' ||
  (delivery.state === 'suppressed' &&
    delivery.error === 'room_stopped' &&
    delivery.attempts === 0 &&
    delivery.intent === 'next')
export const isParticipantPausedDelivery = (delivery: RoomDelivery): boolean =>
  delivery.state === 'suppressed' &&
  delivery.error === PARTICIPANT_PAUSED &&
  delivery.attempts === 0 &&
  delivery.intent === 'next'
export const isParticipantSteerBusy = (data: RoomData, participantId: string): boolean =>
  Object.values(data.deliveries).some(
    (delivery) =>
      delivery.participantId === participantId &&
      ((delivery.state === 'delivering' && delivery.intent === 'steer') ||
        (delivery.state === 'pending' && data.pendingSteerIds?.has(delivery.id)))
  )
export const isMessageMutable = (data: RoomData, messageId: string): boolean => {
  const message = data.messages.find((candidate) => candidate.id === messageId)
  if (
    message?.deliveryAttempted ||
    message?.queueEditing ||
    Object.values(data.deliveries).some(
      (delivery) => delivery.messageId === messageId && data.pendingSteerIds?.has(delivery.id)
    )
  ) {
    return false
  }
  const list = Object.values(data.deliveries).filter((delivery) => delivery.messageId === messageId)
  return list.length > 0
    ? list.every(isMutableDelivery)
    : data.snapshot?.deliveryQueueMutationVersion === 1
}
export const messageDeliveries = (data: RoomData, messageId: string): RoomDelivery[] =>
  Object.values(data.deliveries).filter((delivery) => delivery.messageId === messageId)
export const activeMessageDeliveries = (data: RoomData, messageId: string): RoomDelivery[] => {
  const activeIds = new Set(
    data.snapshot?.participants
      .filter(
        (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
      )
      .map((participant) => participant.id) ?? []
  )
  return messageDeliveries(data, messageId).filter((delivery) =>
    activeIds.has(delivery.participantId)
  )
}

export function roomMessageAudience(data: RoomData, messageId: string): RoomMessageAudience | null {
  const participants =
    data.snapshot?.participants.filter(
      (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
    ) ?? []
  const deliveries = activeMessageDeliveries(data, messageId).filter(
    (delivery) =>
      !(delivery.state === 'suppressed' && delivery.error === 'room_delivery_retargeted')
  )
  if (!deliveries.length || deliveries.length === participants.length) {
    return null
  }
  const identities = deliveries.flatMap((delivery) => {
    const participant = participants.find((candidate) => candidate.id === delivery.participantId)
    return participant ? [participant.identity] : []
  })
  const state = deliveries.some(
    (delivery) => delivery.state === 'delivering' && delivery.intent === 'steer'
  )
    ? 'steering'
    : deliveries.some(
          (delivery) => delivery.state === 'failed' && delivery.error === 'room_delivery_uncertain'
        )
      ? 'uncertain'
      : deliveries.some((delivery) => delivery.state === 'failed')
        ? 'failed'
        : deliveries.some(
              (delivery) => delivery.state === 'suppressed' && delivery.error === 'room_stopped'
            )
          ? 'paused'
          : deliveries.some((delivery) => delivery.state === 'pending')
            ? 'queued'
            : deliveries.some((delivery) => delivery.intent === 'steer')
              ? 'steered'
              : 'directed'
  return identities.length ? { identities, state } : null
}

export function steerEligibleDeliveries(
  data: RoomData,
  state: RoomQueueState,
  messageId: string
): RoomDelivery[] {
  const eligible = new Set(
    state.participants
      .filter(
        (participant) =>
          participant.providerSession?.transport === 'machine' && participant.state === 'busy'
      )
      .map((participant) => participant.id)
  )
  return messageDeliveries(data, messageId).filter(
    (delivery) => delivery.state === 'pending' && eligible.has(delivery.participantId)
  )
}

export function sharedSteerEligible(
  data: RoomData,
  state: RoomQueueState,
  messageId: string
): boolean {
  if (
    data.snapshot?.deliveryQueueMutationVersion !== 1 ||
    !state.shared.some((message) => message.id === messageId)
  ) {
    return false
  }
  const deliveries = messageDeliveries(data, messageId)
  return (
    state.participants.length > 0 &&
    state.participants.every((participant) => {
      const delivery = deliveries.find((item) => item.participantId === participant.id)
      return (
        delivery?.state === 'pending' &&
        delivery.attempts === 0 &&
        participant.providerSession?.transport === 'machine' &&
        !isParticipantSteerBusy(data, participant.id)
      )
    })
  )
}

export function computeRoomQueueState(data: RoomData): RoomQueueState | null {
  if (data.snapshot?.deliveryQueueVersion !== 1) {
    return null
  }
  const participants = data.snapshot.participants.filter(
    (participant) => participant.actorKind === 'agent' && participant.participation === 'active'
  )
  const messageById = new Map(
    data.messages
      .filter((message) => message.actorKind === 'user' && !message.queueEditing)
      .map((message) => [message.id, message])
  )
  const deliveries = Object.values(data.deliveries).filter((delivery) =>
    messageById.has(delivery.messageId)
  )
  const activeIds = new Set(participants.map((participant) => participant.id))
  const queued = deliveries.filter(
    (delivery) =>
      activeIds.has(delivery.participantId) &&
      (delivery.state === 'pending' ||
        (delivery.state === 'delivering' && delivery.intent === 'steer') ||
        delivery.state === 'failed' ||
        (isParticipantPausedDelivery(delivery) &&
          messageById.get(delivery.messageId)?.actorKind === 'user' &&
          isMessageMutable(data, delivery.messageId)) ||
        (delivery.state === 'suppressed' &&
          delivery.error === 'room_stopped' &&
          delivery.attempts === 0 &&
          delivery.intent === 'next'))
  )
  const queueable = deliveries.filter(
    (delivery) => activeIds.has(delivery.participantId) && isQueueableDelivery(delivery)
  )
  const targets = new Map<string, Set<string>>()
  for (const delivery of deliveries) {
    if (!activeIds.has(delivery.participantId)) {
      continue
    }
    if (
      delivery.state === 'suppressed' &&
      (delivery.error === RETARGETED || delivery.error === PARTICIPANT_PAUSED)
    ) {
      continue
    }
    const set = targets.get(delivery.messageId) ?? new Set<string>()
    set.add(delivery.participantId)
    targets.set(delivery.messageId, set)
  }
  const isDirected = (messageId: string): boolean =>
    messageById.get(messageId)?.actorKind !== 'user' ||
    (targets.get(messageId)?.size ?? 0) < participants.length
  const sequenceOf = (messageId: string): number => messageById.get(messageId)?.sequence ?? 0
  const positionOf = (messageId: string): number => {
    const positions = queued
      .filter((delivery) => delivery.messageId === messageId)
      .map((delivery) => delivery.queuePosition ?? FALLBACK_POSITION)
    return positions.length ? Math.min(...positions) : FALLBACK_POSITION
  }
  const queueablePositionOf = (messageId: string): number =>
    Math.min(
      ...queueable
        .filter((delivery) => delivery.messageId === messageId)
        .map((delivery) => delivery.queuePosition ?? FALLBACK_POSITION)
    )
  const queueSort = (a: RoomDelivery, b: RoomDelivery): number =>
    (a.queuePosition ?? FALLBACK_POSITION) - (b.queuePosition ?? FALLBACK_POSITION) ||
    sequenceOf(a.messageId) - sequenceOf(b.messageId)
  const shared = data.messages
    .filter(
      (message) =>
        queued.some((delivery) => delivery.messageId === message.id) && !isDirected(message.id)
    )
    .sort((a, b) => positionOf(a.id) - positionOf(b.id) || a.sequence - b.sequence)
  const sharedPendingIds = shared
    .filter((message) => queueable.some((delivery) => delivery.messageId === message.id))
    .map((message) => message.id)
  const queueableMessageIds = [...new Set(queueable.map((delivery) => delivery.messageId))].sort(
    (a, b) => queueablePositionOf(a) - queueablePositionOf(b) || sequenceOf(a) - sequenceOf(b)
  )
  const directed = new Map<string, RoomDelivery[]>()
  for (const participant of participants) {
    directed.set(
      participant.id,
      queued
        .filter(
          (delivery) => delivery.participantId === participant.id && isDirected(delivery.messageId)
        )
        .sort(queueSort)
    )
  }
  return {
    participants,
    shared,
    sharedPendingIds,
    queueableMessageIds,
    directed,
    targets: new Map([...targets].map(([id, set]) => [id, [...set]])),
    hasDirected: [...directed.values()].some((rows) => rows.length > 0)
  }
}

export function agentPendingQueue(data: RoomData, participantId: string): RoomDelivery[] {
  const sequence = new Map(data.messages.map((message) => [message.id, message.sequence]))
  const userMessageIds = new Set(
    data.messages.filter((message) => message.actorKind === 'user').map((message) => message.id)
  )
  return Object.values(data.deliveries)
    .filter(
      (delivery) =>
        delivery.participantId === participantId &&
        userMessageIds.has(delivery.messageId) &&
        isQueueableDelivery(delivery)
    )
    .sort(
      (a, b) =>
        (a.queuePosition ?? FALLBACK_POSITION) - (b.queuePosition ?? FALLBACK_POSITION) ||
        (sequence.get(a.messageId) ?? 0) - (sequence.get(b.messageId) ?? 0)
    )
}
