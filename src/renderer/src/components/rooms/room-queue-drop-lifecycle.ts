import { parseSharedRowId, type RoomQueueState } from './room-queue-projection'

export type RoomQueueAction =
  | { type: 'retarget'; messageId: string; participantIds: string[] }
  | { type: 'reorderShared'; messageIds: string[]; movedMessageId: string }
  | { type: 'broadcastAndPlace'; messageIds: string[]; messageId: string }
  | {
      type: 'reorderAgent'
      participantId: string
      deliveryIds: string[]
      movedDeliveryId: string
    }
  | { type: 'directAndPlace'; messageId: string; participantId: string; deliveryIds: string[] }

export function isRoomQueueTransfer(action: RoomQueueAction): boolean {
  return action.type !== 'reorderShared' && action.type !== 'reorderAgent'
}

export function isRoomQueueTransferSettled(
  state: RoomQueueState | null,
  itemId: string | null | undefined
): boolean {
  if (!state || !itemId) {
    return false
  }
  const sharedMessageId = parseSharedRowId(itemId)
  return sharedMessageId
    ? !state.shared.some((message) => message.id === sharedMessageId)
    : ![...state.directed.values()].some((items) => items.some((item) => item.id === itemId))
}

export function roomQueueDropKeepsParticipantOpen(
  actions: readonly RoomQueueAction[],
  participantId: string | null
): boolean {
  return participantId !== null && roomQueueDropParticipantId(actions) === participantId
}

export function roomQueueDropParticipantId(actions: readonly RoomQueueAction[]): string | null {
  const targeted = actions.find(
    (action) =>
      action.type === 'retarget' ||
      action.type === 'reorderAgent' ||
      action.type === 'directAndPlace'
  )
  return targeted?.type === 'retarget'
    ? targeted.participantIds.length === 1
      ? targeted.participantIds[0]!
      : null
    : (targeted?.participantId ?? null)
}
