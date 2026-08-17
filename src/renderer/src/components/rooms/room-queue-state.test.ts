import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type {
  RoomDelivery,
  RoomMessage,
  RoomParticipant,
  RoomSnapshot
} from '../../../../shared/rooms'
import {
  SHARED_ZONE_ID,
  agentPendingQueue,
  buildAgentInsert,
  buildAgentReorder,
  buildDormantAgentInsert,
  buildSharedReorder,
  computeRoomQueueState,
  isRoomQueueTransfer,
  isRoomQueueTransferSettled,
  isMessageMutable,
  parseSquareId,
  resolveRoomQueueDrop,
  roomQueueDropKeepsParticipantOpen,
  roomQueueDropParticipantId,
  roomMessageAudience,
  sharedSteerEligible,
  sharedRowId,
  squareId,
  squareOpenId,
  steerEligibleDeliveries
} from './room-queue-state'
import type { RoomData } from './use-room-data'

const participant = (id: string, overrides: Partial<RoomParticipant> = {}): RoomParticipant => ({
  id,
  roomId: 'room',
  identity: id,
  displayName: id,
  actorKind: 'agent',
  agent: 'codex',
  roleId: null,
  worktreeId: null,
  paneKey: null,
  terminalHandle: null,
  providerSession: null,
  processIncarnation: null,
  participation: 'active',
  state: 'online',
  context: EMPTY_AGENT_SESSION_CONTEXT,
  lastSeenAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...overrides
})

const message = (
  id: string,
  sequence: number,
  overrides: Partial<RoomMessage> = {}
): RoomMessage => ({
  id,
  roomId: 'room',
  sequence,
  senderId: null,
  senderIdentity: 'user',
  actorKind: 'user',
  kind: 'chat',
  body: id,
  replyToId: null,
  rootMessageId: null,
  hopCount: 0,
  metadata: {},
  mentions: [],
  attachments: [],
  createdAt: 0,
  editedAt: null,
  deletedAt: null,
  ...overrides
})

const delivery = (
  id: string,
  messageId: string,
  participantId: string,
  overrides: Partial<RoomDelivery> = {}
): RoomDelivery => ({
  id,
  messageId,
  participantId,
  state: 'pending',
  attempts: 0,
  error: null,
  nextAttemptAt: 0,
  deliveredAt: null,
  providerTurnId: null,
  responseMessageId: null,
  respondedAt: null,
  intent: 'next',
  ...overrides
})

const snapshot = (participants: RoomParticipant[], withQueueVersion = true): RoomSnapshot => ({
  room: {
    id: 'room',
    projectId: 'project',
    worktreeId: null,
    name: 'room',
    description: '',
    loopLimit: 5,
    createdAt: 0,
    updatedAt: 0
  },
  participants,
  activities: [],
  roles: [],
  pins: [],
  unread: { roomId: 'room', unreadCount: 0, lastReadSequence: 0 },
  ...(withQueueVersion
    ? { deliveryQueueVersion: 1 as const, deliveryQueueMutationVersion: 1 as const }
    : {})
})

const roomData = (
  participants: RoomParticipant[],
  messages: RoomMessage[],
  deliveries: RoomDelivery[],
  withQueueVersion = true
): RoomData =>
  ({
    snapshot: snapshot(participants, withQueueVersion),
    messages,
    deliveries: Object.fromEntries(deliveries.map((item) => [item.id, item]))
  }) as RoomData

describe('computeRoomQueueState', () => {
  it('returns null without the delivery queue snapshot field', () => {
    expect(computeRoomQueueState(roomData([participant('a')], [], [], false))).toBeNull()
  })

  it('keeps only active agents as square owners', () => {
    const data = roomData(
      [
        participant('a'),
        participant('c', { participation: 'paused' }),
        participant('u', { actorKind: 'user' })
      ],
      [],
      []
    )
    expect(computeRoomQueueState(data)?.participants.map((item) => item.id)).toEqual(['a'])
  })

  it('splits undirected messages into the shared list and directed ones into squares', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d1b', 'm1', 'b', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', { queuePosition: 2 })
      ]
    )
    const state = computeRoomQueueState(data)
    expect(state?.shared.map((item) => item.id)).toEqual(['m1'])
    expect(state?.sharedPendingIds).toEqual(['m1'])
    expect(state?.queueableMessageIds).toEqual(['m1', 'm2'])
    expect(state?.directed.get('a')?.map((item) => item.id)).toEqual(['d2a'])
    expect(state?.directed.get('b')).toEqual([])
    expect(state?.hasDirected).toBe(true)
    expect(state?.targets.get('m1')?.sort()).toEqual(['a', 'b'])
  })

  it('treats a suppressed retarget delivery as removed from the targets', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d1b', 'm1', 'b', { state: 'suppressed', error: 'room_delivery_retargeted' })
      ]
    )
    const state = computeRoomQueueState(data)
    expect(state?.shared).toEqual([])
    expect(state?.queueableMessageIds).toEqual(['m1'])
    expect(state?.targets.get('m1')).toEqual(['a'])
  })

  it('projects a reactivated participant-paused delivery as dormant directed work', () => {
    const paused = delivery('d1b', 'm1', 'b', {
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1)],
      [delivery('d1a', 'm1', 'a', { queuePosition: 1 }), paused]
    )
    const state = computeRoomQueueState(data)

    expect(isMessageMutable(data, 'm1')).toBe(true)
    expect(state?.shared).toEqual([])
    expect(state?.targets.get('m1')).toEqual(['a'])
    expect(state?.directed.get('b')).toEqual([paused])
    expect(agentPendingQueue(data, 'b')).toEqual([])
  })

  it('keeps agent-authored deliveries out of user-managed queues', () => {
    const agentMessage = message('m1', 1, { actorKind: 'agent', senderIdentity: 'author' })
    const data = roomData(
      [
        participant('a', {
          providerSession: { key: 'session_id', id: 'sa', transport: 'machine' },
          state: 'busy'
        }),
        participant('b', {
          providerSession: { key: 'session_id', id: 'sb', transport: 'machine' },
          state: 'busy'
        })
      ],
      [agentMessage],
      [delivery('d1a', 'm1', 'a'), delivery('d1b', 'm1', 'b')]
    )
    const state = computeRoomQueueState(data)!

    expect(state.shared).toEqual([])
    expect(state.directed.get('a')).toEqual([])
    expect(state.directed.get('b')).toEqual([])
    expect(state.queueableMessageIds).toEqual([])
    expect(agentPendingQueue(data, 'a')).toEqual([])
    expect(sharedSteerEligible(data, state, 'm1')).toBe(false)
  })

  it.each([
    { name: 'an attempted user message', actorKind: 'user' as const, deliveryAttempted: true },
    { name: 'an agent-authored message', actorKind: 'agent' as const, deliveryAttempted: false }
  ])('does not project dormant work for $name', ({ actorKind, deliveryAttempted }) => {
    const dormant = delivery('d1b', 'm1', 'b', {
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1, { actorKind, deliveryAttempted })],
      [
        dormant,
        ...(deliveryAttempted
          ? [delivery('d1a', 'm1', 'a', { state: 'delivered', attempts: 1 })]
          : [])
      ]
    )
    const state = computeRoomQueueState(data)!

    expect(state.shared).toEqual([])
    expect(state.directed.get('a')).toEqual([])
    expect(state.directed.get('b')).toEqual([])
  })

  it('orders shared rows by min queue position, then sequence', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 2 }),
        delivery('d2a', 'm2', 'a', { queuePosition: 1 }),
        delivery('d3a', 'm3', 'a', { queuePosition: 1 }),
        delivery('d1b', 'm1', 'b', { queuePosition: 2 }),
        delivery('d2b', 'm2', 'b', { queuePosition: 1 }),
        delivery('d3b', 'm3', 'b', { queuePosition: 1 })
      ]
    )
    expect(computeRoomQueueState(data)?.shared.map((item) => item.id)).toEqual(['m2', 'm3', 'm1'])
  })

  it('counts failed deliveries as queued but not pending', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d1b', 'm1', 'b', { state: 'failed', attempts: 1, queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', { state: 'failed', attempts: 1, queuePosition: 2 })
      ]
    )
    const state = computeRoomQueueState(data)
    expect(state?.shared.map((item) => item.id)).toEqual(['m1'])
    expect(state?.sharedPendingIds).toEqual(['m1'])
    expect(state?.directed.get('a')?.map((item) => item.id)).toEqual(['d2a'])
    expect(state?.queueableMessageIds).toEqual(['m1'])
  })

  it('hides failed deliveries of paused participants until they are active again', () => {
    const failed = delivery('failed', 'm1', 'b', { state: 'failed', attempts: 1 })
    const pausedData = roomData(
      [participant('a'), participant('b', { participation: 'paused' })],
      [message('m1', 1)],
      [failed]
    )
    expect(computeRoomQueueState(pausedData)?.shared).toEqual([])
    expect(computeRoomQueueState(pausedData)?.hasDirected).toBe(false)

    const activeData = roomData([participant('a'), participant('b')], [message('m1', 1)], [failed])
    expect(computeRoomQueueState(activeData)?.directed.get('b')).toEqual([failed])
  })

  it('does not project an already attempted stopped delivery into the queue', () => {
    const data = roomData(
      [participant('a')],
      [message('m1', 1)],
      [
        delivery('d1', 'm1', 'a', {
          state: 'suppressed',
          error: 'room_stopped',
          attempts: 1,
          intent: 'next'
        })
      ]
    )
    const state = computeRoomQueueState(data)
    expect(state?.shared).toEqual([])
    expect(state?.directed.get('a')).toEqual([])
    expect(state?.hasDirected).toBe(false)
  })
})

describe('isMessageMutable', () => {
  const base = [delivery('d1', 'm1', 'a'), delivery('d2', 'm1', 'b')]
  it('is true while every delivery is unattempted pending or suppressed-retargeted', () => {
    expect(isMessageMutable(roomData([], [message('m1', 1)], base), 'm1')).toBe(true)
    const suppressed = base.map((item, index) =>
      index === 1
        ? { ...item, state: 'suppressed' as const, error: 'room_delivery_retargeted' }
        : item
    )
    expect(isMessageMutable(roomData([], [message('m1', 1)], suppressed), 'm1')).toBe(true)
  })
  it('is false once any delivery is attempted or in flight', () => {
    expect(
      isMessageMutable(
        roomData([], [message('m1', 1)], [base[0]!, { ...base[1]!, state: 'delivering' }]),
        'm1'
      )
    ).toBe(false)
    expect(
      isMessageMutable(
        roomData([], [message('m1', 1)], [base[0]!, { ...base[1]!, state: 'failed', attempts: 1 }]),
        'm1'
      )
    ).toBe(false)
  })
  it('is true for a never-claimed message without deliveries', () => {
    expect(isMessageMutable(roomData([], [message('m1', 1)], []), 'm1')).toBe(true)
  })
  it('remains false from the persisted marker after deliveries disappear', () => {
    const attempted = { ...message('m1', 1), deliveryAttempted: true }
    expect(isMessageMutable(roomData([], [attempted], []), 'm1')).toBe(false)
  })
  it('is false without host support for zero-delivery mutation', () => {
    const data = roomData([], [message('m1', 1)], [])
    data.snapshot!.deliveryQueueMutationVersion = undefined
    expect(isMessageMutable(data, 'm1')).toBe(false)
  })
})

describe('buildSharedReorder', () => {
  it('moves one shared message through the full mixed queue', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3), message('m4', 4)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', { queuePosition: 2 }),
        delivery('d3a', 'm3', 'a', { queuePosition: 3 }),
        delivery('d2b', 'm2', 'b', { queuePosition: 2 }),
        delivery('d3b', 'm3', 'b', { queuePosition: 3 }),
        delivery('d4a', 'm4', 'a', { queuePosition: 4 })
      ]
    )
    const state = computeRoomQueueState(data)
    const result = buildSharedReorder(state!, 'm3', 'm2')
    expect(result).toEqual(['m1', 'm3', 'm2', 'm4'])
    expect(result?.filter((id) => id !== 'm3')).toEqual(['m1', 'm2', 'm4'])
    expect(buildSharedReorder(state!, 'm2', 'm2')).toBeNull()
    expect(buildSharedReorder(state!, 'm4', 'm2')).toBeNull()
  })
})

describe('buildAgentReorder', () => {
  it('moves one directed delivery through the full mixed queue', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3), message('m4', 4)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', { queuePosition: 2 }),
        delivery('d3a', 'm3', 'a', { queuePosition: 3 }),
        delivery('d4a', 'm4', 'a', { queuePosition: 4 }),
        delivery('d2b', 'm2', 'b', { queuePosition: 2 }),
        delivery('d4b', 'm4', 'b', { queuePosition: 4 })
      ]
    )
    const state = computeRoomQueueState(data)
    const result = buildAgentReorder(data, state!, 'a', 'd3a', 'd1a')
    expect(result).toEqual(['d3a', 'd1a', 'd2a', 'd4a'])
    expect(result?.filter((id) => id !== 'd3a')).toEqual(['d1a', 'd2a', 'd4a'])
    expect(result?.sort()).toEqual(
      agentPendingQueue(data, 'a')
        .map((item) => item.id)
        .sort()
    )
    expect(buildAgentReorder(data, state!, 'a', 'd1a', 'd1a')).toBeNull()
  })

  it('does not send mutable retargeted records in a later reorder payload', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', {
          state: 'suppressed',
          error: 'room_delivery_retargeted',
          queuePosition: 2
        }),
        delivery('d3a', 'm3', 'a', { queuePosition: 3 })
      ]
    )
    const state = computeRoomQueueState(data)!

    expect(buildAgentReorder(data, state, 'a', 'd3a', 'd1a')).toEqual(['d3a', 'd1a'])
  })
})

describe('buildAgentInsert', () => {
  it('moves one shared delivery through hidden and retry rows', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3), message('m4', 4)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', { queuePosition: 2 }),
        delivery('d3a', 'm3', 'a', { attempts: 1, queuePosition: 3 }),
        delivery('d4a', 'm4', 'a', { queuePosition: 4 }),
        delivery('d2b', 'm2', 'b', { queuePosition: 2 }),
        delivery('d4b', 'm4', 'b', { queuePosition: 4 })
      ]
    )
    const state = computeRoomQueueState(data)
    const result = buildAgentInsert(data, state!, 'a', 'm4', 'd1a')
    expect(result).toEqual(['d4a', 'd1a', 'd2a', 'd3a'])
    expect(result?.filter((id) => id !== 'd4a')).toEqual(['d1a', 'd2a', 'd3a'])
    expect(buildAgentInsert(data, state!, 'a', 'm4', 'd4a')).toBeNull()
  })
})

describe('buildDormantAgentInsert', () => {
  it('inserts a dormant target without reordering the active queue', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1), message('m2', 2), message('m3', 3)],
      [
        delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
        delivery('d2a', 'm2', 'a', {
          state: 'suppressed',
          error: 'room_participant_paused',
          queuePosition: 2
        }),
        delivery('d3a', 'm3', 'a', { queuePosition: 3 })
      ]
    )

    expect(buildDormantAgentInsert(data, 'a', 'd2a', 'd1a')).toEqual(['d2a', 'd1a', 'd3a'])
  })
})

describe('resolveRoomQueueDrop', () => {
  const data = roomData(
    [participant('a'), participant('b')],
    [message('m1', 1), message('m2', 2), message('m3', 3), message('m4', 4)],
    [
      delivery('d1a', 'm1', 'a', { queuePosition: 1 }),
      delivery('d2a', 'm2', 'a', { queuePosition: 2 }),
      delivery('d3a', 'm3', 'a', { queuePosition: 3 }),
      delivery('d4a', 'm4', 'a', { queuePosition: 4 }),
      delivery('d2b', 'm2', 'b', { queuePosition: 2 }),
      delivery('d3b', 'm3', 'b', { queuePosition: 3 })
    ]
  )
  const state = computeRoomQueueState(data)!
  it('does nothing without an over target or on an unknown one', () => {
    expect(resolveRoomQueueDrop(data, state, sharedRowId('m2'), null)).toEqual([])
    expect(resolveRoomQueueDrop(data, state, sharedRowId('m2'), 'junk')).toEqual([])
  })
  it('directs a shared row onto a square (collapsed and expanded)', () => {
    const actions = resolveRoomQueueDrop(data, state, sharedRowId('m2'), squareId('b'))
    expect(actions).toEqual([{ type: 'retarget', messageId: 'm2', participantIds: ['b'] }])
    expect(resolveRoomQueueDrop(data, state, sharedRowId('m2'), squareOpenId('b'))).toEqual([
      { type: 'retarget', messageId: 'm2', participantIds: ['b'] }
    ])
    expect(actions.some(isRoomQueueTransfer)).toBe(true)
    expect(roomQueueDropKeepsParticipantOpen(actions, 'b')).toBe(true)
    expect(roomQueueDropParticipantId(actions)).toBe('b')
    expect(isRoomQueueTransferSettled(state, sharedRowId('m2'))).toBe(false)
    expect(
      isRoomQueueTransferSettled(
        { ...state, shared: state.shared.filter((message) => message.id !== 'm2') },
        sharedRowId('m2')
      )
    ).toBe(true)
  })
  it('directs an agent row onto another square and ignores its own', () => {
    expect(resolveRoomQueueDrop(data, state, 'd1a', squareId('b'))).toEqual([
      { type: 'retarget', messageId: 'm1', participantIds: ['b'] }
    ])
    expect(resolveRoomQueueDrop(data, state, 'd1a', squareId('a'))).toEqual([])
  })
  it('returns a directed row to the room queue (mirror drag)', () => {
    expect(resolveRoomQueueDrop(data, state, 'd1a', SHARED_ZONE_ID)).toEqual([
      { type: 'retarget', messageId: 'm1', participantIds: ['a', 'b'] }
    ])
    expect(resolveRoomQueueDrop(data, state, 'd1a', sharedRowId('m2'))).toEqual([
      { type: 'retarget', messageId: 'm1', participantIds: ['a', 'b'] }
    ])
  })
  it('atomically returns and places a directed row on supported hosts', () => {
    data.snapshot!.broadcastQueuePlacementVersion = 1
    expect(
      resolveRoomQueueDrop(data, state, 'd1a', sharedRowId('m3'), {
        overMessageId: 'm3',
        after: false
      })
    ).toEqual([
      {
        type: 'broadcastAndPlace',
        messageId: 'm1',
        messageIds: ['m2', 'm1', 'm3', 'm4']
      }
    ])
    data.snapshot!.broadcastQueuePlacementVersion = undefined
  })
  it('reorders shared rows with the exact full pending set', () => {
    expect(resolveRoomQueueDrop(data, state, sharedRowId('m3'), sharedRowId('m2'))).toEqual([
      {
        type: 'reorderShared',
        messageIds: ['m1', 'm3', 'm2', 'm4'],
        movedMessageId: 'm3'
      }
    ])
  })
  it('directs and places a shared row onto an expanded agent row', () => {
    expect(resolveRoomQueueDrop(data, state, sharedRowId('m2'), 'd1a')).toEqual([
      {
        type: 'directAndPlace',
        messageId: 'm2',
        participantId: 'a',
        deliveryIds: ['d2a', 'd1a', 'd3a', 'd4a']
      }
    ])
  })
  it('falls back to targeting when the host cannot place atomically', () => {
    const legacyData = {
      ...data,
      snapshot: { ...data.snapshot!, deliveryQueueMutationVersion: undefined }
    }
    const legacyState = computeRoomQueueState(legacyData)!

    expect(resolveRoomQueueDrop(legacyData, legacyState, sharedRowId('m2'), 'd1a')).toEqual([
      { type: 'retarget', messageId: 'm2', participantIds: ['a'] }
    ])
  })
  it('reorders rows within one square, keeping hidden slots', () => {
    const actions = resolveRoomQueueDrop(data, state, 'd4a', 'd1a')
    expect(actions).toEqual([
      {
        type: 'reorderAgent',
        participantId: 'a',
        deliveryIds: ['d4a', 'd1a', 'd2a', 'd3a'],
        movedDeliveryId: 'd4a'
      }
    ])
    expect(actions.some(isRoomQueueTransfer)).toBe(false)
    expect(roomQueueDropKeepsParticipantOpen(actions, 'a')).toBe(true)
  })
  it('retargets a row onto another agent row', () => {
    expect(resolveRoomQueueDrop(data, state, 'd1a', 'd3b')).toEqual([
      { type: 'retarget', messageId: 'm1', participantIds: ['b'] }
    ])
  })

  it('reactivates and places a dormant row in its own queue', () => {
    const dormantData = roomData(
      [participant('a'), participant('b')],
      [message('dormant', 1), message('anchor', 2)],
      [
        delivery('dormant-a', 'dormant', 'a', {
          state: 'suppressed',
          error: 'room_participant_paused',
          queuePosition: 1
        }),
        delivery('anchor-a', 'anchor', 'a', { queuePosition: 2 })
      ]
    )
    const dormantState = computeRoomQueueState(dormantData)!

    expect(resolveRoomQueueDrop(dormantData, dormantState, 'dormant-a', 'anchor-a')).toEqual([
      {
        type: 'directAndPlace',
        messageId: 'dormant',
        participantId: 'a',
        deliveryIds: ['dormant-a', 'anchor-a']
      }
    ])
    expect(resolveRoomQueueDrop(dormantData, dormantState, 'dormant-a', squareOpenId('a'))).toEqual(
      [{ type: 'retarget', messageId: 'dormant', participantIds: ['a'] }]
    )
  })
})

describe('steerEligibleDeliveries', () => {
  it('keeps only pending deliveries of machine participants that are busy', () => {
    const data = roomData(
      [
        participant('a', {
          providerSession: { key: 'session_id', id: 's', transport: 'machine' },
          state: 'busy'
        }),
        participant('b', { state: 'busy' })
      ],
      [message('m1', 1)],
      [
        delivery('d1a', 'm1', 'a'),
        delivery('d1b', 'm1', 'b'),
        delivery('d2a', 'm1', 'a', { state: 'failed', attempts: 1 })
      ]
    )
    const state = computeRoomQueueState(data)
    expect(steerEligibleDeliveries(data, state!, 'm1').map((item) => item.id)).toEqual(['d1a'])
  })
})

describe('roomMessageAudience', () => {
  it('keeps a directed steer visible with its current target and state', () => {
    const data = roomData(
      [participant('a'), participant('b')],
      [message('m1', 1)],
      [
        delivery('d1a', 'm1', 'a', { state: 'delivering', intent: 'steer' }),
        delivery('d1b', 'm1', 'b', {
          state: 'suppressed',
          error: 'room_delivery_retargeted'
        })
      ]
    )

    expect(
      computeRoomQueueState(data)
        ?.directed.get('a')
        ?.map((item) => item.id)
    ).toEqual(['d1a'])
    expect(roomMessageAudience(data, 'm1')).toEqual({ identities: ['a'], state: 'steering' })
    data.deliveries.d1a = delivery('d1a', 'm1', 'a', {
      state: 'delivered',
      attempts: 1,
      intent: 'steer'
    })
    expect(roomMessageAudience(data, 'm1')).toEqual({ identities: ['a'], state: 'steered' })
  })
})

describe('sharedSteerEligible', () => {
  it('requires current host support in addition to machine transports', () => {
    const data = roomData(
      [
        participant('a', {
          providerSession: { key: 'session_id', id: 'sa', transport: 'machine' },
          state: 'busy'
        }),
        participant('b', {
          providerSession: { key: 'session_id', id: 'sb', transport: 'machine' },
          state: 'online'
        })
      ],
      [message('m1', 1)],
      [delivery('d1a', 'm1', 'a'), delivery('d1b', 'm1', 'b')]
    )
    const state = computeRoomQueueState(data)!

    expect(sharedSteerEligible(data, state, 'm1')).toBe(true)
    data.deliveries.busy = delivery('busy', 'other', 'a', {
      state: 'delivering',
      attempts: 1,
      intent: 'steer'
    })
    expect(sharedSteerEligible(data, state, 'm1')).toBe(false)
    data.snapshot!.deliveryQueueMutationVersion = undefined
    expect(sharedSteerEligible(data, state, 'm1')).toBe(false)
  })
})

describe('parseSquareId', () => {
  it('resolves both collapsed and expanded droppable ids', () => {
    expect(parseSquareId(squareId('a'))).toBe('a')
    expect(parseSquareId(squareOpenId('a'))).toBe('a')
    expect(parseSquareId('other')).toBeNull()
  })
})
