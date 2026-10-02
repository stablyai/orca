import { roomDataFixture } from './room-data.test-fixture'
import {
  roomMessageFixture,
  roomDeliveryFixture,
  roomParticipantFixture,
  roomActivityFixture
} from '../../../../shared/rooms.test-fixture'
// @vitest-environment happy-dom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomAgentActivity } from '../../../../shared/rooms'
import { useAppStore } from '@/store'

import {
  buildRoomFeedItems,
  orderRoomActivities,
  pendingDeliveryActivities,
  RoomMessageFeed
} from './RoomMessageFeed'

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly observed: Element[] = []

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.push(element)
  }

  unobserve(): void {}
  disconnect(): void {}
}

describe('RoomMessageFeed', () => {
  beforeEach(() => {
    TestResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('publishes user messages only after claim while keeping agent and untargeted messages', () => {
    const messages = [
      roomMessageFixture({ id: 'queued', actorKind: 'user' }),
      roomMessageFixture({ id: 'claimed', actorKind: 'user', deliveryAttempted: true }),
      roomMessageFixture({ id: 'legacy-claimed', actorKind: 'user' }),
      roomMessageFixture({ id: 'agent', actorKind: 'agent' }),
      roomMessageFixture({ id: 'untargeted', actorKind: 'user' })
    ]
    const deliveries = [
      roomDeliveryFixture({ id: 'queued-delivery', messageId: 'queued', attempts: 0 }),
      roomDeliveryFixture({ id: 'claimed-delivery', messageId: 'claimed', attempts: 1 }),
      roomDeliveryFixture({ id: 'legacy-delivery', messageId: 'legacy-claimed', attempts: 1 }),
      roomDeliveryFixture({ id: 'agent-delivery', messageId: 'agent', attempts: 0 })
    ]

    expect(buildRoomFeedItems(messages, deliveries).map((item) => item.message.id)).toEqual([
      'claimed',
      'legacy-claimed',
      'agent',
      'untargeted'
    ])
  })

  it('orders activities by start, with directed ones first in mention order', () => {
    const activity = (
      participantId: string,
      identity: string,
      startedAt: number,
      anchorSequence: number | null = 7
    ): RoomAgentActivity => ({
      participantId,
      identity,
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt,
      updatedAt: startedAt,
      anchorSequence
    })

    const message = roomMessageFixture({ id: 'prompt', sequence: 7, mentions: ['claude', 'codex'] })
    expect(
      orderRoomActivities(
        [message],
        [
          activity('optional', 'omp', 1),
          activity('codex', 'codex', 2),
          activity('claude', 'claude', 3)
        ]
      ).map(({ participantId }) => participantId)
    ).toEqual(['claude', 'codex', 'optional'])

    // No mention anchor: stable order by who started earlier.
    expect(
      orderRoomActivities(
        [roomMessageFixture({ id: 'prompt', sequence: 7 })],
        [activity('second', 'second', 20, null), activity('first', 'first', 10, null)]
      ).map(({ participantId }) => participantId)
    ).toEqual(['first', 'second'])
  })

  it('shows one standard working activity until provider activity arrives', () => {
    const message = roomMessageFixture({ id: 'message', sequence: 7, createdAt: 10 })
    const delivery = roomDeliveryFixture({
      id: 'delivery',
      messageId: message.id,
      participantId: 'codex',
      state: 'delivering'
    })
    const participant = roomParticipantFixture({ id: 'codex', identity: 'codex' })

    expect(pendingDeliveryActivities([delivery], [message], [participant], [])).toMatchObject([
      { participantId: 'codex', kind: 'working', state: 'working' }
    ])
    expect(
      pendingDeliveryActivities(
        [delivery],
        [message],
        [participant],
        [roomActivityFixture({ participantId: 'codex' })]
      )
    ).toEqual([])
  })

  it('does not show queued deliveries as active work before claim', () => {
    const message = roomMessageFixture({ id: 'message', sequence: 7, createdAt: 10 })
    const participant = roomParticipantFixture({ id: 'codex', identity: 'codex' })
    const delivery = roomDeliveryFixture({
      id: 'delivery',
      messageId: message.id,
      participantId: participant.id,
      state: 'pending'
    })

    expect(pendingDeliveryActivities([delivery], [message], [participant], [])).toEqual([])
  })

  it('keeps an expanded activity pinned only while the reader is at the bottom', () => {
    const { container } = render(
      <RoomMessageFeed
        data={roomDataFixture({
          messages: [],
          activities: {},
          snapshot: null,
          hasMore: false,
          roomId: null,
          readerKey: 'user'
        })}
      />
    )
    const scroller = container.firstElementChild
    const content = scroller?.firstElementChild
    if (!(scroller instanceof HTMLDivElement) || !(content instanceof HTMLDivElement)) {
      throw new Error('Missing message feed scroller')
    }
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 }
    })
    const observer = TestResizeObserver.instances.find((item) => item.observed.includes(content))
    expect(observer).toBeTruthy()

    act(() => observer?.callback([], observer))
    expect(scroller.scrollTop).toBe(400)

    scroller.scrollTop = 50
    fireEvent.scroll(scroller)
    act(() => observer?.callback([], observer))
    expect(scroller.scrollTop).toBe(50)
  })

  it('renders participants before their agent status is hydrated', () => {
    useAppStore.setState({ agentStatusByPaneKey: {} })

    expect(() =>
      render(
        <RoomMessageFeed
          data={roomDataFixture({
            messages: [],
            activities: {},
            snapshot: {
              unread: { unreadCount: 0 },
              participants: [
                {
                  id: 'codex',
                  identity: 'codex',
                  displayName: 'Codex',
                  actorKind: 'agent',
                  agent: 'codex',
                  paneKey: 'tab:leaf',
                  providerSession: null
                }
              ]
            },
            target: { kind: 'local' },
            hasMore: false,
            roomId: null,
            readerKey: 'user'
          })}
        />
      )
    ).not.toThrow()
  })
})
