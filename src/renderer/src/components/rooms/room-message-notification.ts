import { dispatchNotification } from '@/components/terminal-pane/use-notification-dispatch'
import type { RoomEvent } from '../../../../shared/rooms'

const notifiedMessageIds = new Set<string>()

export function notifyRoomMessage(event: RoomEvent): void {
  if (
    event.type !== 'message.created' ||
    event.message.actorKind !== 'agent' ||
    notifiedMessageIds.has(event.message.id)
  ) {
    return
  }
  notifiedMessageIds.add(event.message.id)
  if (notifiedMessageIds.size > 1_000) {
    notifiedMessageIds.delete(notifiedMessageIds.values().next().value!)
  }
  dispatchNotification({
    source: 'agent-task-complete',
    notificationId: `room:${event.message.id}`,
    worktreeId: event.notification?.worktreeId ?? undefined,
    paneKey: event.notification?.paneKey ?? undefined,
    terminalTitle: event.notification
      ? `${event.notification.roomName} · @${event.message.senderIdentity}`
      : `@${event.message.senderIdentity}`,
    agentType: event.notification?.agent ?? undefined,
    agentLastAssistantMessage: event.message.body
  })
}
