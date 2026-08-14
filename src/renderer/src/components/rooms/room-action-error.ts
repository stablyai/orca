import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

const messages: Record<string, string> = {
  room_delivery_queue_stale: "This action isn't valid for the current queue state.",
  room_delivery_not_found: 'This queued delivery no longer exists.',
  room_delivery_target_invalid: 'That agent is no longer available.',
  room_delivery_stopped: 'The room queue is paused.',
  room_stop_in_progress: 'The room is still stopping.',
  room_agent_not_ready: 'An agent is not ready.',
  room_agent_handoff_restore_failed:
    'Machine handoff failed and the terminal could not be restored.',
  room_agent_cleanup_failed: 'The agent could not be cleaned up after the room action failed.',
  room_agent_control_unsupported: 'This agent does not support that control.',
  room_message_not_found: 'This message no longer exists.',
  room_participant_not_found: 'That agent is no longer in the room.',
  room_reply_not_found: 'The message you replied to is no longer available.',
  conversation_steer_unsupported: 'Steer requires machine transport.',
  conversation_steer_busy: 'A Steer is already being submitted to this agent.',
  conversation_not_working: 'The agent is not currently working.',
  codex_steer_rejected: 'Codex rejected Steer for the current turn; the message remains queued.'
}

export function roomErrorMessage(error: unknown, fallback: string): string {
  const message = typeof error === 'string' ? error : extractIpcErrorMessage(error, fallback)
  return messages[message] ?? (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(message) ? fallback : message)
}

export function showRoomActionError(error: unknown): void {
  toast.error(extractIpcErrorMessage(error, 'Room action failed.'))
}
