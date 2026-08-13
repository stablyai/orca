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
import { buildRoomFeedItems, pendingDeliveryActivities, RoomMessageFeed } from './RoomMessageFeed'

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

  it('pins live activities below the whole feed in stable start order', () => {
    const activity = (
      participantId: string,
      startedAt: number,
      anchorSequence: number | null
    ): RoomAgentActivity => ({
      participantId,
      identity: participantId,
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt,
      updatedAt: startedAt + 100,
      anchorSequence
    })

    // 'first' answers an older message (its queue lags behind the tail); the
    // pill must still pin below every message, ordered by who started earlier.
    const items = buildRoomFeedItems(
      [{ id: 'prompt', sequence: 7 } as RoomMessage, { id: 'later', sequence: 8 } as RoomMessage],
      [activity('second', 20, 8), activity('first', 10, 7)]
    )

    expect(items.map((item) => item.key)).toEqual(['message:prompt', 'message:later', 'activities'])
    expect(items.at(-1)).toMatchObject({
      kind: 'activities',
      activities: [{ participantId: 'first' }, { participantId: 'second' }]
    })
  })

  it('puts directed activities first in mention order', () => {
    const message = {
      id: 'prompt',
      sequence: 7,
      mentions: ['claude', 'codex']
    } as RoomMessage
    const activity = (
      participantId: string,
      identity: string,
      startedAt: number
    ): RoomAgentActivity => ({
      participantId,
      identity,
      state: 'working',
      kind: 'thinking',
      messages: [],
      startedAt,
      updatedAt: startedAt,
      anchorSequence: 7
    })

    const items = buildRoomFeedItems(
      [message],
      [
        activity('optional', 'omp', 1),
        activity('codex', 'codex', 2),
        activity('claude', 'claude', 3)
      ]
    )

    expect(items.at(-1)).toMatchObject({
      kind: 'activities',
      activities: [
        { participantId: 'claude' },
        { participantId: 'codex' },
        { participantId: 'optional' }
      ]
    })
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
