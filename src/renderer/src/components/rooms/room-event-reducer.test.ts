import { describe, expect, it } from 'vitest'
import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomMessage,
  RoomSnapshot
} from '../../../../shared/rooms'
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

  it('accepts room work state updates and preserves them when absent', () => {
    const room = { id: 'room' } as RoomSnapshot['room']
    const initial = {
      ...EMPTY_ACTIVE_ROOM,
      snapshot: { room, workState: 'stopped' } as RoomSnapshot
    }
    const resumed = reduceRoomEvent(initial, {
      type: 'room.updated',
      room,
      workState: 'idle'
    })

    expect(resumed.snapshot?.workState).toBe('idle')
    expect(reduceRoomEvent(resumed, { type: 'room.updated', room }).snapshot?.workState).toBe(
      'idle'
    )
  })

  it('does not let a stale queue load overwrite a live delivery update', () => {
    const live = { id: 'delivery-1', state: 'delivering' } as RoomDelivery
    const stale = { id: 'delivery-1', state: 'pending' } as RoomDelivery
    const state = reduceRoomEvent(
      { ...EMPTY_ACTIVE_ROOM, deliveries: { [live.id]: live } },
      { type: 'local.messages.loaded', messages: [], deliveries: [stale] }
    )

    expect(state.deliveries[live.id].state).toBe('delivering')
  })

  it('restores only the latest unresolved confirmed Steer from loaded deliveries', () => {
    const snapshot = {
      participants: [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'agent-c' }],
      activities: []
    } as unknown as RoomSnapshot
    const loaded = reduceRoomEvent(
      { ...EMPTY_ACTIVE_ROOM, snapshot },
      {
        type: 'local.messages.loaded',
        messages: [],
        deliveries: [
          {
            id: 'steer-a',
            participantId: 'agent-a',
            state: 'delivered',
            intent: 'steer',
            deliveredAt: 10,
            respondedAt: null
          } as RoomDelivery,
          {
            id: 'steer-b',
            participantId: 'agent-b',
            state: 'delivered',
            intent: 'steer',
            deliveredAt: 20,
            respondedAt: null
          } as RoomDelivery,
          {
            id: 'steer-c',
            participantId: 'agent-c',
            state: 'delivering',
            intent: 'steer',
            deliveredAt: null,
            respondedAt: null
          } as RoomDelivery
        ]
      }
    )
    const liveMarker = reduceRoomEvent(
      { ...loaded, lastSteeredParticipantId: 'agent-a' },
      {
        type: 'local.messages.loaded',
        messages: [],
        deliveries: [
          {
            id: 'steer-b-newer',
            participantId: 'agent-b',
            state: 'delivered',
            intent: 'steer',
            deliveredAt: 30,
            respondedAt: null
          } as RoomDelivery
        ]
      }
    )
    const stalePage = reduceRoomEvent(
      {
        ...EMPTY_ACTIVE_ROOM,
        snapshot,
        deliveries: {
          settled: {
            id: 'settled',
            participantId: 'agent-b',
            state: 'delivered',
            intent: 'steer',
            deliveredAt: 40,
            respondedAt: 50
          } as RoomDelivery
        }
      },
      {
        type: 'local.messages.loaded',
        messages: [],
        deliveries: [
          {
            id: 'settled',
            participantId: 'agent-b',
            state: 'delivered',
            intent: 'steer',
            deliveredAt: 40,
            respondedAt: null
          } as RoomDelivery
        ]
      }
    )
    const pageFirst = reduceRoomEvent(EMPTY_ACTIVE_ROOM, {
      type: 'local.messages.loaded',
      messages: [],
      deliveries: Object.values(loaded.deliveries)
    })
    const snapshotAfterPage = reduceRoomEvent(pageFirst, { type: 'snapshot', snapshot })

    expect(loaded.lastSteeredParticipantId).toBe('agent-b')
    expect(liveMarker.lastSteeredParticipantId).toBe('agent-a')
    expect(stalePage.lastSteeredParticipantId).toBeNull()
    expect(pageFirst.lastSteeredParticipantId).toBeNull()
    expect(snapshotAfterPage.lastSteeredParticipantId).toBe('agent-b')
  })

  it('does not let page merge clear a persisted or live delivery lock', () => {
    const persisted = { id: 'persisted', deliveryAttempted: true } as RoomMessage
    const live = { id: 'persisted', body: 'live' } as RoomMessage
    const state = reduceRoomEvent(
      { ...EMPTY_ACTIVE_ROOM, messages: [live] },
      { type: 'local.messages.loaded', messages: [persisted], deliveries: [] }
    )

    expect(state.messages).toMatchObject([
      { id: persisted.id, body: 'live', deliveryAttempted: true }
    ])
  })

  it('removes cascaded deliveries with their participant', () => {
    const removed = { id: 'removed', participantId: 'agent-1' } as RoomDelivery
    const kept = { id: 'kept', participantId: 'agent-2' } as RoomDelivery
    const state = reduceRoomEvent(
      {
        ...EMPTY_ACTIVE_ROOM,
        snapshot: { participants: [{ id: 'agent-1' }, { id: 'agent-2' }] } as RoomSnapshot,
        deliveries: { [removed.id]: removed, [kept.id]: kept }
      },
      { type: 'participant.removed', participantId: 'agent-1' }
    )

    expect(state.deliveries).toEqual({ [kept.id]: kept })
    expect(state.snapshot?.participants).toEqual([{ id: 'agent-2' }])
  })

  it('keeps a message delivery lock after its participant and delivery disappear', () => {
    const message = { id: 'message' } as RoomMessage
    const claimed = reduceRoomEvent(
      {
        ...EMPTY_ACTIVE_ROOM,
        messages: [message],
        snapshot: { participants: [{ id: 'agent' }] } as RoomSnapshot
      },
      {
        type: 'delivery.updated',
        delivery: {
          id: 'delivery',
          messageId: message.id,
          participantId: 'agent',
          attempts: 1
        } as RoomDelivery
      }
    )
    const removed = reduceRoomEvent(claimed, {
      type: 'participant.removed',
      participantId: 'agent'
    })

    expect(removed.messages[0].deliveryAttempted).toBe(true)
    expect(removed.deliveries).toEqual({})
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

  it('tracks confirmed steer order without provider user rows', () => {
    const activity = (participantId: string): RoomAgentActivity => ({
      participantId,
      identity: participantId,
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt: 1,
      updatedAt: 1,
      anchorSequence: null
    })
    const attemptedA = reduceRoomEvent(EMPTY_ACTIVE_ROOM, {
      type: 'delivery.updated',
      delivery: {
        id: 'steer-a',
        participantId: 'agent-a',
        state: 'delivering',
        intent: 'steer'
      } as RoomDelivery
    })
    const confirmedA = reduceRoomEvent(attemptedA, {
      type: 'delivery.updated',
      delivery: {
        id: 'steer-a',
        participantId: 'agent-a',
        state: 'delivered',
        intent: 'steer'
      } as RoomDelivery
    })
    const afterA = reduceRoomEvent(confirmedA, {
      type: 'activity.updated',
      activity: activity('agent-a')
    })
    const ordinaryB = reduceRoomEvent(afterA, {
      type: 'delivery.updated',
      delivery: {
        id: 'next-b',
        participantId: 'agent-b',
        state: 'delivered',
        intent: 'next'
      } as RoomDelivery
    })
    const confirmedB = reduceRoomEvent(ordinaryB, {
      type: 'delivery.updated',
      delivery: {
        id: 'steer-b',
        participantId: 'agent-b',
        state: 'delivered',
        intent: 'steer'
      } as RoomDelivery
    })
    const afterB = reduceRoomEvent(confirmedB, {
      type: 'activity.updated',
      activity: activity('agent-b')
    })
    const repeatedB = reduceRoomEvent(afterB, {
      type: 'activity.updated',
      activity: { ...activity('agent-b'), updatedAt: 2 }
    })
    const cleared = reduceRoomEvent(repeatedB, {
      type: 'activity.cleared',
      participantId: 'agent-b'
    })

    expect(attemptedA.lastSteeredParticipantId).toBeNull()
    expect(ordinaryB.lastSteeredParticipantId).toBe('agent-a')
    expect(afterB.lastSteeredParticipantId).toBe('agent-b')
    expect(repeatedB.lastSteeredParticipantId).toBe('agent-b')
    expect(cleared.lastSteeredParticipantId).toBeNull()
  })
})
