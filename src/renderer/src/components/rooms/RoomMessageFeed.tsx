import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomMessage,
  RoomParticipant
} from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import { RoomActivityStack } from './RoomActivityStack'
import { RoomMessageRow } from './RoomMessageRow'
import { showRoomActionError } from './room-action-error'
import { isRoomDeliveryActive } from './room-delivery-state'

type RoomFeedItem =
  | { kind: 'message'; key: string; message: RoomMessage }
  | { kind: 'activities'; key: string; activities: RoomAgentActivity[] }

export function buildRoomFeedItems(
  messages: RoomMessage[],
  activities: RoomAgentActivity[]
): RoomFeedItem[] {
  const items: RoomFeedItem[] = messages.map((message) => ({
    kind: 'message',
    key: `message:${message.id}`,
    message
  }))
  // Live activities always pin below the whole feed: an agent may be answering
  // a message far above the tail (its queue lags), and mid-feed pills detach
  // from view. startedAt is fixed at turn start, so the block order is stable
  // for the whole turn regardless of which agent acted last.
  const pending = [...activities].sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.participantId.localeCompare(right.participantId)
  )
  if (pending.length > 0) {
    items.push({
      kind: 'activities',
      key: 'activities',
      activities: pending
    })
  }
  return items
}

export function pendingDeliveryActivities(
  deliveries: RoomDelivery[],
  messages: RoomMessage[],
  participants: RoomParticipant[],
  activities: RoomAgentActivity[]
): RoomAgentActivity[] {
  const activeParticipants = new Set(activities.map((activity) => activity.participantId))
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const participantById = new Map(participants.map((participant) => [participant.id, participant]))
  const pending = new Map<string, RoomAgentActivity>()
  for (const delivery of deliveries) {
    if (activeParticipants.has(delivery.participantId) || !isRoomDeliveryActive(delivery)) {
      continue
    }
    const message = messageById.get(delivery.messageId)
    const participant = participantById.get(delivery.participantId)
    if (!message || !participant || pending.has(participant.id)) {
      continue
    }
    pending.set(participant.id, {
      participantId: participant.id,
      identity: participant.identity,
      state: 'working',
      kind: 'working',
      messages: [],
      startedAt: message.createdAt,
      updatedAt: message.createdAt,
      anchorSequence: message.sequence
    })
  }
  return [...pending.values()]
}

export function RoomMessageFeed({
  data,
  onReply
}: {
  data: RoomData
  onReply: (message: RoomMessage) => void
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const previousLatestRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(atBottom)
  atBottomRef.current = atBottom
  const messages = data.messages
  const participants = useMemo(
    () => data.snapshot?.participants ?? [],
    [data.snapshot?.participants]
  )
  const activities = useMemo(() => {
    const live = Object.values(data.activities)
    return [
      ...live,
      ...pendingDeliveryActivities(
        Object.values(data.deliveries ?? {}),
        messages,
        participants,
        live
      )
    ]
  }, [data.activities, data.deliveries, messages, participants])
  const feedItems = useMemo(() => buildRoomFeedItems(messages, activities), [activities, messages])
  const getItemKey = useCallback((index: number) => feedItems[index]?.key ?? index, [feedItems])
  const latest = messages.at(-1)
  const unreadCount = data.snapshot?.unread.unreadCount ?? 0
  const virtualizer = useVirtualizer({
    count: feedItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 110,
    overscan: 8,
    getItemKey
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !atBottomRef.current

  const markRead = useCallback(() => {
    if (!latest || !data.roomId || !document.hasFocus() || document.hidden) {
      return
    }
    void roomRpc(data.target, 'rooms.read', {
      roomId: data.roomId,
      readerKey: data.readerKey,
      sequence: latest.sequence
    }).catch(() => {})
  }, [data.readerKey, data.roomId, data.target, latest])

  useEffect(() => {
    if (!latest) {
      return
    }
    const previous = previousLatestRef.current
    previousLatestRef.current = latest.sequence
    if ((previous === null || atBottom) && feedItems.length > 0) {
      requestAnimationFrame(() => virtualizer.scrollToIndex(feedItems.length - 1, { align: 'end' }))
      markRead()
    }
  }, [atBottom, feedItems.length, latest, markRead, virtualizer])

  useEffect(() => {
    const onVisible = (): void => {
      if (atBottom) {
        markRead()
      }
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [atBottom, markRead])

  useEffect(() => {
    const element = parentRef.current
    const content = contentRef.current
    if (!element || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        element.scrollTop = element.scrollHeight
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={parentRef}
      className="relative min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
      onScroll={(event) => {
        const element = event.currentTarget
        const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        atBottomRef.current = next
        setAtBottom(next)
        if (next) {
          markRead()
        }
      }}
    >
      <div ref={contentRef}>
        {data.hasMore ? (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void data.loadOlder().catch(showRoomActionError)}
            >
              {translate('rooms.feed.loadOlder', 'Load older')}
            </Button>
          </div>
        ) : null}
        <div
          className="relative mx-auto w-full max-w-4xl"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const item = feedItems[row.index]
            if (!item) {
              return null
            }
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 top-0 w-full px-4 py-2"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {item.kind === 'message' ? (
                  <RoomMessageRow data={data} message={item.message} onReply={onReply} />
                ) : (
                  <RoomActivityStack
                    key={item.activities.length > 1 ? 'stack' : 'single'}
                    activities={item.activities}
                    participants={participants}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
      {!atBottom && unreadCount > 0 ? (
        <Button
          size="sm"
          className="sticky bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md"
          onClick={() => {
            virtualizer.scrollToIndex(feedItems.length - 1, { align: 'end' })
            atBottomRef.current = true
            setAtBottom(true)
            markRead()
          }}
        >
          {translate('rooms.feed.newMessages', '{{count}} new messages', {
            count: unreadCount
          })}
        </Button>
      ) : null}
    </div>
  )
}
