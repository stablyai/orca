import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { StreamingMarkdownFadeRoot } from '@/components/sidebar/streaming-markdown-fade'
import { translate } from '@/i18n/i18n'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type {
  RoomAgentActivity,
  RoomDelivery,
  RoomMessage,
  RoomParticipant
} from '../../../../shared/rooms'
import type { RoomData } from './use-room-data'
import { RoomMessageRow } from './RoomMessageRow'
import { showRoomActionError } from './room-action-error'
import { isRoomDeliveryActive } from './room-delivery-state'

type RoomFeedItem = { kind: 'message'; key: string; message: RoomMessage }

export function buildRoomFeedItems(
  messages: readonly RoomMessage[],
  deliveries: readonly RoomDelivery[] = []
): RoomFeedItem[] {
  const targeted = new Set(deliveries.map((delivery) => delivery.messageId))
  const attempted = new Set(
    deliveries.filter((delivery) => delivery.attempts > 0).map((delivery) => delivery.messageId)
  )
  return messages
    .filter(
      (message) =>
        message.actorKind !== 'user' ||
        !targeted.has(message.id) ||
        message.deliveryAttempted === true ||
        attempted.has(message.id)
    )
    .map((message) => ({
      kind: 'message',
      key: `message:${message.id}`,
      message
    }))
}

export function orderRoomActivities(
  messages: RoomMessage[],
  activities: RoomAgentActivity[]
): RoomAgentActivity[] {
  const ordered = [...activities].sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.participantId.localeCompare(right.participantId)
  )
  const activityByAnchorIdentity = new Map(
    ordered
      .filter((activity) => activity.anchorSequence !== null)
      .map((activity) => [
        `${activity.anchorSequence}:${activity.identity.toLocaleLowerCase()}`,
        activity
      ])
  )
  const anchor = messages.findLast((message) =>
    (message.mentions ?? []).some((identity) =>
      activityByAnchorIdentity.has(`${message.sequence}:${identity.toLocaleLowerCase()}`)
    )
  )
  if (!anchor) {
    return ordered
  }
  const directed = (anchor.mentions ?? [])
    .map((identity) =>
      activityByAnchorIdentity.get(`${anchor.sequence}:${identity.toLocaleLowerCase()}`)
    )
    .filter((activity): activity is RoomAgentActivity => Boolean(activity))
  const directedIds = new Set(directed.map((activity) => activity.participantId))
  return [...directed, ...ordered.filter((activity) => !directedIds.has(activity.participantId))]
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

export function RoomMessageFeed({ data }: { data: RoomData }): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const previousLatestRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(atBottom)
  atBottomRef.current = atBottom
  const messages = data.messages
  const feedItems = useMemo(
    () => buildRoomFeedItems(messages, Object.values(data.deliveries ?? {})),
    [data.deliveries, messages]
  )
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
    observer.observe(element)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <StreamingMarkdownFadeRoot
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
                <RoomMessageRow data={data} message={item.message} />
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
    </StreamingMarkdownFadeRoot>
  )
}
