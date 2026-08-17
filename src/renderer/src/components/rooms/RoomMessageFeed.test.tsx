// @vitest-environment happy-dom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomMessage,
  RoomParticipant
} from '../../../../shared/rooms'
import { useAppStore } from '@/store'
import type { RoomData } from './use-room-data'
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
      { id: 'queued', actorKind: 'user' },
      { id: 'claimed', actorKind: 'user', deliveryAttempted: true },
      { id: 'legacy-claimed', actorKind: 'user' },
      { id: 'agent', actorKind: 'agent' },
      { id: 'untargeted', actorKind: 'user' }
    ] as RoomMessage[]
    const deliveries = [
      { id: 'queued-delivery', messageId: 'queued', attempts: 0 },
      { id: 'claimed-delivery', messageId: 'claimed', attempts: 1 },
      { id: 'legacy-delivery', messageId: 'legacy-claimed', attempts: 1 },
      { id: 'agent-delivery', messageId: 'agent', attempts: 0 }
    ] as RoomDelivery[]

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

    const message = { id: 'prompt', sequence: 7, mentions: ['claude', 'codex'] } as RoomMessage
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
        [{ id: 'prompt', sequence: 7 } as RoomMessage],
        [activity('second', 'second', 20, null), activity('first', 'first', 10, null)]
      ).map(({ participantId }) => participantId)
    ).toEqual(['first', 'second'])
  })

  it('shows one standard working activity until provider activity arrives', () => {
    const message = { id: 'message', sequence: 7, createdAt: 10 } as RoomMessage
    const delivery = {
      id: 'delivery',
      messageId: message.id,
      participantId: 'codex',
      state: 'delivering'
    } as RoomDelivery
    const participant = { id: 'codex', identity: 'codex' } as RoomParticipant

    expect(pendingDeliveryActivities([delivery], [message], [participant], [])).toMatchObject([
      { participantId: 'codex', kind: 'working', state: 'working' }
    ])
    expect(
      pendingDeliveryActivities(
        [delivery],
        [message],
        [participant],
        [{ participantId: 'codex' } as RoomAgentActivity]
      )
    ).toEqual([])
  })

  it('does not show queued deliveries as active work before claim', () => {
    const message = { id: 'message', sequence: 7, createdAt: 10 } as RoomMessage
    const participant = { id: 'codex', identity: 'codex' } as RoomParticipant
    const delivery = {
      id: 'delivery',
      messageId: message.id,
      participantId: participant.id,
      state: 'pending'
    } as RoomDelivery

    expect(pendingDeliveryActivities([delivery], [message], [participant], [])).toEqual([])
  })

  it('keeps an expanded activity pinned only while the reader is at the bottom', () => {
    const { container } = render(
      <RoomMessageFeed
        data={
          {
            messages: [],
            activities: {},
            snapshot: null,
            hasMore: false,
            roomId: null,
            readerKey: 'user'
          } as unknown as RoomData
        }
        onReply={() => {}}
      />
    )
    const scroller = container.firstElementChild as HTMLDivElement
    const content = scroller.firstElementChild as HTMLDivElement
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 }
    })
    const observer = TestResizeObserver.instances.find((item) => item.observed.includes(content))
    expect(observer).toBeTruthy()

    act(() => observer?.callback([], observer as unknown as ResizeObserver))
    expect(scroller.scrollTop).toBe(400)

    scroller.scrollTop = 50
    fireEvent.scroll(scroller)
    act(() => observer?.callback([], observer as unknown as ResizeObserver))
    expect(scroller.scrollTop).toBe(50)
  })

  it('renders participants before their agent status is hydrated', () => {
    useAppStore.setState({ agentStatusByPaneKey: {} })

    expect(() =>
      render(
        <RoomMessageFeed
          data={
            {
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
            } as unknown as RoomData
          }
          onReply={() => {}}
        />
      )
    ).not.toThrow()
  })
})
