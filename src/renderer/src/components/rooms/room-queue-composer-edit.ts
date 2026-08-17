import type { RoomMessage } from '../../../../shared/rooms'

export type RoomQueueComposerEdit = {
  message: RoomMessage
  editToken: string
  targetParticipantIds: string[] | null
}
