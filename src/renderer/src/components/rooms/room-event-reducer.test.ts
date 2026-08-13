import { describe, expect, it } from 'vitest'
import type { RoomAgentActivity, RoomDelivery, RoomSnapshot } from '../../../../shared/rooms'
import { EMPTY_ACTIVE_ROOM, reduceRoomEvent } from './room-event-reducer'

describe('room transient activity state', () => {
  it('accepts the authoritative work state on delivery updates', () => {
    const stopped = reduceRoomEvent(
      { ...EMPTY_ACTIVE_ROOM, snapshot: { workState: 'active' } as RoomSnapshot },
      {
        type: 'delivery.updated',
        delivery: { id: 'delivery-1' } as RoomDelivery,
        workState: 'stopped'
      }
    )

    expect(stopped.snapshot?.workState).toBe('stopped')
  })

  it('keeps activity outside persisted messages and clears it on final', () => {
    const activity: RoomAgentActivity = {
      participantId: 'agent-1',
      identity: 'codex',
      state: 'working',
      kind: 'command',
      detail: 'git status',
      messages: [],
      startedAt: 1,
      updatedAt: 10,
      anchorSequence: 4
    }
    const working = reduceRoomEvent(EMPTY_ACTIVE_ROOM, { type: 'activity.updated', activity })
    const completed = reduceRoomEvent(working, {
      type: 'activity.cleared',
      participantId: activity.participantId
    })

    expect(working.activities).toEqual({ 'agent-1': activity })
    expect(working.messages).toEqual([])
    expect(completed.activities).toEqual({})
  })

  it('replaces live activity in the same update that adds the final message', () => {
    const activity: RoomAgentActivity = {
      participantId: 'agent-1',
      identity: 'codex',
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt: 1,
      updatedAt: 2,
      anchorSequence: 1
    }
    const working = reduceRoomEvent(EMPTY_ACTIVE_ROOM, { type: 'activity.updated', activity })
    const completed = reduceRoomEvent(working, {
      type: 'message.created',
      message: {
        id: 'final',
        roomId: 'room',
        sequence: 2,
        senderId: 'agent-1',
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
        createdAt: 3,
        editedAt: null,
        deletedAt: null
      }
    })

    expect(completed.activities).toEqual({})
    expect(completed.messages.map((message) => message.id)).toEqual(['final'])
  })
})
