import type { RoomDelivery, RoomParticipant } from '../../../../shared/rooms'
import type { QueuedMessageItem } from '../native-chat/QueuedMessageCard'
import { translate } from '@/i18n/i18n'
import { roomErrorMessage } from './room-action-error'
import {
  activeMessageDeliveries,
  isMessageMutable,
  isParticipantPausedDelivery,
  isParticipantSteerBusy,
  sharedRowId,
  sharedSteerEligible,
  type RoomQueueState
} from './room-queue-state'
import type { RoomData } from './use-room-data'

export function roomSharedQueueItems(
  data: RoomData,
  state: RoomQueueState,
  editingMessageId?: string
): QueuedMessageItem[] {
  return state.shared
    .filter((message) => message.id !== editingMessageId)
    .map((message) => {
      const deliveries = activeMessageDeliveries(data, message.id)
      const failed = deliveries.filter((delivery) => delivery.state === 'failed')
      const stopped = deliveries.some(
        (delivery) => delivery.state === 'suppressed' && delivery.error === 'room_stopped'
      )
      const submitting =
        data.snapshot?.workState !== 'stopped' &&
        deliveries.some(
          (delivery) =>
            (delivery.state === 'delivering' && delivery.intent === 'steer') ||
            (delivery.state === 'pending' && data.pendingSteerIds?.has(delivery.id))
        )
      const queueStopped = data.snapshot?.workState === 'stopped'
      const isUser = message.actorKind === 'user'
      return {
        id: sharedRowId(message.id),
        text: message.body,
        state: submitting
          ? 'submitting'
          : queueStopped || stopped
            ? 'paused'
            : failed.length
              ? failed.some((delivery) => delivery.error === 'room_delivery_uncertain')
                ? 'uncertain'
                : 'paused'
              : 'pending',
        error: failed.length ? roomErrorMessage(failed[0]?.error, 'Delivery failed.') : undefined,
        detail: submitting
          ? translate('rooms.queue.steeringAll', 'Steering to all active agents…')
          : undefined,
        canSteer: !queueStopped && sharedSteerEligible(data, state, message.id),
        dragDisabled: !isUser || !isMessageMutable(data, message.id),
        canEdit: isUser && isMessageMutable(data, message.id),
        canRemove: isUser && isMessageMutable(data, message.id)
      }
    })
}

export function roomDirectedQueueItems(
  data: RoomData,
  participant: RoomParticipant | null,
  deliveries: readonly RoomDelivery[]
): QueuedMessageItem[] {
  if (!participant) {
    return []
  }
  return deliveries.map((delivery) => {
    const message = data.messages.find((candidate) => candidate.id === delivery.messageId)!
    const failed = delivery.state === 'failed'
    const stopped = delivery.state === 'suppressed' && delivery.error === 'room_stopped'
    const submitting =
      data.snapshot?.workState !== 'stopped' &&
      ((delivery.state === 'delivering' && delivery.intent === 'steer') ||
        (delivery.state === 'pending' && data.pendingSteerIds?.has(delivery.id)))
    const participantPaused = isParticipantPausedDelivery(delivery)
    const queueStopped = data.snapshot?.workState === 'stopped'
    const isUser = message.actorKind === 'user'
    return {
      id: delivery.id,
      text: message.body,
      state: submitting
        ? 'submitting'
        : queueStopped || stopped || participantPaused
          ? 'paused'
          : failed
            ? delivery.error === 'room_delivery_uncertain'
              ? 'uncertain'
              : 'paused'
            : 'pending',
      error: failed ? roomErrorMessage(delivery.error, 'Delivery failed.') : undefined,
      detail: submitting ? translate('rooms.queue.steering', 'Steering to the agent…') : undefined,
      canSteer:
        !failed &&
        !stopped &&
        !participantPaused &&
        !queueStopped &&
        delivery.attempts === 0 &&
        participant.providerSession?.transport === 'machine' &&
        participant.state === 'busy' &&
        !isParticipantSteerBusy(data, participant.id),
      dragDisabled: failed || !isUser || !isMessageMutable(data, message.id),
      canEdit: isUser && !failed && isMessageMutable(data, message.id),
      canRemove:
        data.snapshot?.deliveryQueueMutationVersion === 1 &&
        isUser &&
        !failed &&
        isMessageMutable(data, message.id)
    }
  })
}
