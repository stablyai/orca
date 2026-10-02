import { arrayMove } from '@dnd-kit/sortable'
import type { RoomData } from './use-room-data'
import type { RoomQueueAction } from './room-queue-drop-lifecycle'
import {
  agentPendingQueue,
  isMessageMutable,
  isParticipantPausedDelivery,
  isQueueableDelivery,
  parseSharedRowId,
  parseSquareId,
  SHARED_ZONE_ID,
  type RoomQueueState
} from './room-queue-projection'
export * from './room-queue-projection'
export * from './room-queue-drop-lifecycle'

export function buildSharedReorder(
  state: RoomQueueState,
  fromId: string,
  toId: string
): string[] | null {
  if (!state.sharedPendingIds.includes(fromId) || !state.sharedPendingIds.includes(toId)) {
    return null
  }
  const from = state.queueableMessageIds.indexOf(fromId)
  const to = state.queueableMessageIds.indexOf(toId)
  if (from === -1 || to === -1 || from === to) {
    return null
  }
  return arrayMove(state.queueableMessageIds, from, to)
}

export function buildSharedInsert(
  state: RoomQueueState,
  messageId: string,
  overMessageId: string | null,
  after: boolean
): string[] | null {
  if (
    !state.queueableMessageIds.includes(messageId) ||
    (overMessageId !== null && !state.sharedPendingIds.includes(overMessageId))
  ) {
    return null
  }
  const remaining = state.queueableMessageIds.filter((id) => id !== messageId)
  const overIndex = overMessageId === null ? remaining.length : remaining.indexOf(overMessageId)
  if (overIndex === -1) {
    return null
  }
  return remaining.toSpliced(overIndex + (after && overMessageId !== null ? 1 : 0), 0, messageId)
}

const directedPendingIds = (state: RoomQueueState, participantId: string): string[] =>
  (state.directed.get(participantId) ?? [])
    .filter(isQueueableDelivery)
    .map((delivery) => delivery.id)

export function buildAgentReorder(
  data: RoomData,
  state: RoomQueueState,
  participantId: string,
  fromId: string,
  toId: string
): string[] | null {
  const visible = directedPendingIds(state, participantId)
  if (!visible.includes(fromId) || !visible.includes(toId)) {
    return null
  }
  const full = agentPendingQueue(data, participantId)
  const from = full.findIndex((delivery) => delivery.id === fromId)
  const to = full.findIndex((delivery) => delivery.id === toId)
  return from === -1 || to === -1 || from === to
    ? null
    : arrayMove(full, from, to).map((delivery) => delivery.id)
}

export function buildAgentInsert(
  data: RoomData,
  state: RoomQueueState,
  participantId: string,
  messageId: string,
  overId: string
): string[] | null {
  const full = agentPendingQueue(data, participantId)
  const moved = full.find((delivery) => delivery.messageId === messageId)
  const over = full.find((delivery) => delivery.id === overId)
  if (
    !moved ||
    !over ||
    moved.id === over.id ||
    !directedPendingIds(state, participantId).includes(over.id)
  ) {
    return null
  }
  return arrayMove(full, full.indexOf(moved), full.indexOf(over)).map((delivery) => delivery.id)
}

export function buildDormantAgentInsert(
  data: RoomData,
  participantId: string,
  deliveryId: string,
  overId: string
): string[] | null {
  const full = agentPendingQueue(data, participantId)
  const dormant = data.deliveries[deliveryId]
  const over = full.find((delivery) => delivery.id === overId)
  if (
    !dormant ||
    dormant.participantId !== participantId ||
    !isParticipantPausedDelivery(dormant) ||
    !over
  ) {
    return null
  }
  return full.toSpliced(full.indexOf(over), 0, dormant).map((delivery) => delivery.id)
}

/** Map a drop (active row id, resolved over id) to the exact backend actions. */
export function resolveRoomQueueDrop(
  data: RoomData,
  state: RoomQueueState,
  activeId: string,
  overId: string | null,
  sharedPlacement?: { overMessageId: string | null; after: boolean }
): RoomQueueAction[] {
  if (!overId) {
    return []
  }
  const activeSharedId = parseSharedRowId(activeId)
  const overSharedId = parseSharedRowId(overId)
  const overSquareId = parseSquareId(overId)
  const allIds = state.participants.map((participant) => participant.id)
  const activeMessageId = activeSharedId ?? data.deliveries[activeId]?.messageId
  if (activeMessageId) {
    const message = data.messages.find((candidate) => candidate.id === activeMessageId)
    if (!message || message.actorKind !== 'user' || !isMessageMutable(data, activeMessageId)) {
      return []
    }
  }

  if (overSquareId) {
    if (activeSharedId) {
      return [{ type: 'retarget', messageId: activeSharedId, participantIds: [overSquareId] }]
    }
    const activeDelivery = data.deliveries[activeId]
    if (
      activeDelivery &&
      activeDelivery.participantId === overSquareId &&
      isParticipantPausedDelivery(activeDelivery)
    ) {
      return [
        { type: 'retarget', messageId: activeDelivery.messageId, participantIds: [overSquareId] }
      ]
    }
    if (activeDelivery && activeDelivery.participantId !== overSquareId) {
      return [
        { type: 'retarget', messageId: activeDelivery.messageId, participantIds: [overSquareId] }
      ]
    }
    return []
  }

  if (overSharedId || overId === SHARED_ZONE_ID) {
    if (!activeSharedId) {
      const activeDelivery = data.deliveries[activeId]
      if (!activeDelivery) {
        return []
      }
      if (data.snapshot?.broadcastQueuePlacementVersion === 1 && sharedPlacement) {
        const messageIds = buildSharedInsert(
          state,
          activeDelivery.messageId,
          sharedPlacement.overMessageId,
          sharedPlacement.after
        )
        if (messageIds) {
          return [
            {
              type: 'broadcastAndPlace',
              messageIds,
              messageId: activeDelivery.messageId
            }
          ]
        }
      }
      return [{ type: 'retarget', messageId: activeDelivery.messageId, participantIds: allIds }]
    }
    if (overSharedId && overSharedId !== activeSharedId) {
      const messageIds = buildSharedReorder(state, activeSharedId, overSharedId)
      if (messageIds) {
        return [{ type: 'reorderShared', messageIds, movedMessageId: activeSharedId }]
      }
    }
    return []
  }

  const overDelivery = data.deliveries[overId]
  if (!overDelivery) {
    return []
  }
  if (activeSharedId) {
    if (data.snapshot?.deliveryQueueMutationVersion !== 1) {
      return [
        {
          type: 'retarget',
          messageId: activeSharedId,
          participantIds: [overDelivery.participantId]
        }
      ]
    }
    const deliveryIds = buildAgentInsert(
      data,
      state,
      overDelivery.participantId,
      activeSharedId,
      overId
    )
    return deliveryIds
      ? [
          {
            type: 'directAndPlace',
            messageId: activeSharedId,
            participantId: overDelivery.participantId,
            deliveryIds
          }
        ]
      : [
          {
            type: 'retarget',
            messageId: activeSharedId,
            participantIds: [overDelivery.participantId]
          }
        ]
  }
  const activeDelivery = data.deliveries[activeId]
  if (!activeDelivery) {
    return []
  }
  if (activeDelivery.participantId === overDelivery.participantId) {
    if (isParticipantPausedDelivery(activeDelivery)) {
      const deliveryIds = buildDormantAgentInsert(
        data,
        overDelivery.participantId,
        activeId,
        overId
      )
      return deliveryIds
        ? [
            {
              type: 'directAndPlace',
              messageId: activeDelivery.messageId,
              participantId: overDelivery.participantId,
              deliveryIds
            }
          ]
        : []
    }
    const deliveryIds = buildAgentReorder(data, state, overDelivery.participantId, activeId, overId)
    return deliveryIds
      ? [
          {
            type: 'reorderAgent',
            participantId: overDelivery.participantId,
            deliveryIds,
            movedDeliveryId: activeId
          }
        ]
      : []
  }
  return [
    {
      type: 'retarget',
      messageId: activeDelivery.messageId,
      participantIds: [overDelivery.participantId]
    }
  ]
}
