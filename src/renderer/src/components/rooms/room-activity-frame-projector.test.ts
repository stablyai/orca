// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  RoomAgentActivity,
  RoomEvent,
  RoomMessage,
  RoomParticipant,
  RoomSnapshot
} from '../../../../shared/rooms'
import { RoomActivityFrameProjector } from './room-activity-frame-projector'

afterEach(() => vi.restoreAllMocks())

describe('RoomActivityFrameProjector', () => {
  it('drains a machine activity before replacing it with the final room message', () => {
    const tick = installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(machineParticipant()) })
    projector.push({ type: 'activity.updated', activity: activity('x'.repeat(60)) })
    projector.push({ type: 'message.created', message: roomMessage() })
    projector.push({ type: 'activity.cleared', participantId: 'participant' })

    expect(latestActivityText(events)).toBe('')
    expect(events.some((event) => event.type === 'message.created')).toBe(false)
    tick()
    tick()
    tick()

    expect(latestActivityText(events)).toHaveLength(60)
    expect(events.findIndex((event) => event.type === 'message.created')).toBeGreaterThan(
      events.findLastIndex((event) => event.type === 'activity.updated')
    )
  })

  it('does not change PTY room activity timing', () => {
    installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(ptyParticipant()) })
    projector.push({ type: 'activity.updated', activity: activity('complete') })

    expect(latestActivityText(events)).toBe('complete')
  })

  it('keeps later participant events behind the final drain', () => {
    const tick = installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(machineParticipant()) })
    projector.push({ type: 'activity.updated', activity: activity('x'.repeat(60)) })
    projector.push({ type: 'message.created', message: roomMessage() })
    projector.push({ type: 'activity.cleared', participantId: 'participant' })
    projector.push({
      type: 'activity.updated',
      activity: { ...activity('next'), startedAt: 3, updatedAt: 3 }
    })
    tick()
    tick()
    tick()

    const finalIndex = events.findIndex((event) => event.type === 'message.created')
    const nextIndex = events.findIndex(
      (event) => event.type === 'activity.updated' && event.activity.startedAt === 3
    )
    expect(finalIndex).toBeGreaterThan(-1)
    expect(nextIndex).toBeGreaterThan(finalIndex)
  })

  it('clears a silent final without draining room control text', () => {
    installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(machineParticipant()) })
    projector.push({
      type: 'activity.updated',
      activity: activity('<orca-room-silent />', 'final')
    })
    projector.push({ type: 'activity.cleared', participantId: 'participant' })

    expect(latestActivityText(events)).toBe('')
    expect(events.at(-1)).toEqual({ type: 'activity.cleared', participantId: 'participant' })
  })

  it('hides room recipient transport from active structured replies', () => {
    installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(ptyParticipant()) })
    projector.push({
      type: 'activity.updated',
      activity: activity('Still working.\n<orca-room-recipients>["codex2"]</orca-room-recipients>')
    })

    expect(latestActivityText(events)).toBe('Still working.')
  })

  it('shows a disabled harness final only as the completed room message', () => {
    installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector(
      (event) => events.push(event),
      () => false
    )

    projector.push({ type: 'snapshot', snapshot: snapshot(machineParticipant('claude')) })
    projector.push({ type: 'activity.updated', activity: activity('complete', 'final') })
    expect(latestActivityText(events)).toBe('')

    projector.push({ type: 'message.created', message: roomMessage('complete') })
    expect(events.at(-1)?.type).toBe('message.created')
  })

  it('reveals a buffered Claude room final at 120 characters per second', () => {
    const tick = installFrameClock()
    const events: RoomEvent[] = []
    const projector = new RoomActivityFrameProjector((event) => events.push(event))

    projector.push({ type: 'snapshot', snapshot: snapshot(machineParticipant('claude')) })
    projector.push({
      type: 'activity.updated',
      activity: activity('x'.repeat(240), 'final')
    })
    projector.push({ type: 'message.created', message: roomMessage('x'.repeat(240)) })

    for (let frame = 0; frame < 60; frame += 1) {
      tick(1_000 / 60)
    }
    expect(latestActivityText(events)).toHaveLength(119)
    expect(events.some((event) => event.type === 'message.created')).toBe(false)
    for (let frame = 0; frame < 61; frame += 1) {
      tick(1_000 / 60)
    }
    expect(events.at(-1)?.type).toBe('message.created')
  })
})

function snapshot(participant: RoomParticipant): RoomSnapshot {
  return {
    room: {
      id: 'room',
      projectId: 'project',
      worktreeId: 'worktree',
      name: 'Room',
      description: '',
      loopLimit: 10,
      createdAt: 1,
      updatedAt: 1
    },
    participants: [participant],
    activities: [],
    roles: [],
    pins: [],
    unread: { roomId: 'room', unreadCount: 0, lastReadSequence: 0 }
  }
}

function machineParticipant(agent: RoomParticipant['agent'] = 'codex'): RoomParticipant {
  return {
    ...ptyParticipant(),
    agent,
    identity: agent ?? 'codex',
    displayName: agent ?? 'Codex',
    providerSession: { key: 'session_id', id: 'conversation', transport: 'machine' }
  }
}

function ptyParticipant(): RoomParticipant {
  return {
    id: 'participant',
    roomId: 'room',
    identity: 'codex',
    displayName: 'Codex',
    actorKind: 'agent',
    agent: 'codex',
    roleId: null,
    worktreeId: 'worktree',
    paneKey: 'pane',
    terminalHandle: 'terminal',
    providerSession: null,
    processIncarnation: null,
    participation: 'active',
    state: 'busy',
    context: {
      model: null,
      effort: null,
      usedTokens: null,
      maxTokens: null,
      remainingTokens: null,
      usedPercent: null,
      source: 'unavailable',
      observedAt: null,
      compaction: 'idle',
      compactionUpdatedAt: null
    },
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function activity(
  text: string,
  assistantPhase?: NativeChatMessage['assistantPhase']
): RoomAgentActivity {
  return {
    participantId: 'participant',
    identity: 'codex',
    state: 'working',
    kind: 'thinking',
    messages: [nativeMessage(text, assistantPhase)],
    startedAt: 1,
    updatedAt: 2,
    anchorSequence: 1
  }
}

function nativeMessage(
  text: string,
  assistantPhase?: NativeChatMessage['assistantPhase']
): NativeChatMessage {
  return {
    id: 'native-message',
    turnId: 'turn',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'stream',
    ...(assistantPhase ? { assistantPhase } : {})
  }
}

function roomMessage(body = 'x'.repeat(60)): RoomMessage {
  return {
    id: 'room-message',
    roomId: 'room',
    sequence: 2,
    senderId: 'participant',
    senderIdentity: 'codex',
    actorKind: 'agent',
    kind: 'chat',
    body,
    replyToId: null,
    rootMessageId: null,
    hopCount: 0,
    metadata: {},
    mentions: [],
    attachments: [],
    createdAt: 2,
    editedAt: null,
    deletedAt: null
  }
}

function latestActivityText(events: RoomEvent[]): string {
  const event = events.findLast((candidate) => candidate.type === 'activity.updated')
  if (event?.type !== 'activity.updated') {
    return ''
  }
  const block = event.activity.messages[0]?.blocks[0]
  return block?.type === 'text' ? block.text : ''
}

function installFrameClock(): (elapsed?: number) => void {
  let nextId = 1
  let timestamp = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId
    nextId += 1
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => callbacks.delete(id))
  return (elapsed = 16) => {
    timestamp += elapsed
    const current = [...callbacks.values()]
    callbacks.clear()
    for (const callback of current) {
      callback(timestamp)
    }
  }
}
