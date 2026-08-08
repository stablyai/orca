import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomEvent } from '../../../../shared/rooms'
import { notifyRoomMessage } from './room-message-notification'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        notifications: { customSoundId: 'two-tone', customSoundVolume: 65 }
      }
    })
  }
}))

describe('notifyRoomMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        }
      }
    })
  })

  it('dispatches one notification and configured sound for an agent message', async () => {
    const event: RoomEvent = {
      type: 'message.created',
      message: {
        id: 'message-normal-reply',
        roomId: 'room-1',
        sequence: 1,
        senderId: 'participant-1',
        senderIdentity: 'codex',
        actorKind: 'agent',
        kind: 'chat',
        body: 'Done.',
        replyToId: null,
        rootMessageId: null,
        hopCount: 0,
        metadata: {},
        mentions: [],
        attachments: [],
        createdAt: 1,
        editedAt: null,
        deletedAt: null
      },
      notification: {
        roomName: 'Release room',
        worktreeId: 'worktree-1',
        paneKey: 'tab-1:pane-1',
        agent: 'codex'
      }
    }

    notifyRoomMessage(event)
    notifyRoomMessage(event)

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'room:message-normal-reply',
        worktreeId: 'worktree-1',
        paneKey: 'tab-1:pane-1',
        terminalTitle: 'Release room · @codex',
        agentLastAssistantMessage: 'Done.'
      })
    )
    await vi.waitFor(() => {
      expect(window.api.notifications.playSound).toHaveBeenCalledTimes(1)
      expect(window.api.notifications.playSound).toHaveBeenCalledWith({ volume: 65 })
    })
  })
})
