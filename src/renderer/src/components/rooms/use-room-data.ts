import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Room, RoomEvent, RoomMessagePage, RoomSnapshot } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc, subscribeRoom } from '@/runtime/runtime-rooms-client'
import { EMPTY_ACTIVE_ROOM, reduceRoomEvent } from './room-event-reducer'
import { closeRoomTabs, useRoomTabs } from './use-room-tabs'
import { closeRoomTabsForEnd } from './room-deletion-lifecycle'
import { RoomActivityFrameProjector } from './room-activity-frame-projector'
import { useRoomSteerRequests } from './use-room-steer-requests'

export function useRoomData(
  target: RuntimeClientTarget,
  projectId: string | null,
  roomId: string | null
) {
  const [rooms, setRooms] = useState<Room[]>([])
  useRoomTabs(rooms)
  const [state, dispatch] = useReducer(reduceRoomEvent, EMPTY_ACTIVE_ROOM)
  const { steerDelivery, pendingSteerIds } = useRoomSteerRequests(target, roomId, state.deliveries)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readerKey = 'user'
  const snapshotRef = useRef<RoomSnapshot | null>(null)
  const historyCursorRef = useRef<{ roomId: string; beforeSequence: number | null } | null>(null)
  const roomsRequestRef = useRef(0)
  const roomIdRef = useRef(roomId)
  const loadingOlderRef = useRef(false)
  roomIdRef.current = roomId

  const refreshRooms = useCallback(async () => {
    const request = ++roomsRequestRef.current
    if (!projectId) {
      setRooms([])
      setLoading(false)
      setError(null)
      return
    }
    setRooms([])
    setLoading(true)
    try {
      const result = await roomRpc<{ rooms: Room[] }>(target, 'rooms.list', {
        projectId
      })
      if (request !== roomsRequestRef.current) {
        return
      }
      setRooms(result.rooms)
      setError(null)
    } catch (cause) {
      if (request === roomsRequestRef.current) {
        setError(message(cause))
      }
    } finally {
      if (request === roomsRequestRef.current) {
        setLoading(false)
      }
    }
  }, [projectId, target])

  useEffect(() => void refreshRooms(), [refreshRooms])

  useEffect(() => {
    dispatch({ type: 'local.reset' })
    snapshotRef.current = null
    if (!roomId) {
      return
    }
    let disposed = false
    let unsubscribe = (): void => {}
    const applyEvent = (event: RoomEvent): void => {
      if (disposed) {
        return
      }
      if (event.type === 'end') {
        closeRoomTabsForEnd(event, roomId)
        return
      }
      snapshotRef.current = updateSnapshotRef(snapshotRef.current, event)
      dispatch(event)
      if (event.type === 'room.updated') {
        setRooms((current) =>
          current.map((room) => (room.id === event.room.id ? event.room : room))
        )
      }
    }
    const projector = new RoomActivityFrameProjector(applyEvent)
    void subscribeRoom(
      target,
      roomId,
      readerKey,
      (event) => !disposed && projector.push(event),
      (cause) => {
        if (!disposed) {
          const text = message(cause)
          if (text === 'room_not_found') {
            closeRoomTabs(roomId)
          } else {
            setError(text)
          }
        }
      }
    ).then(
      (subscription) => {
        if (disposed) {
          subscription.unsubscribe()
        } else {
          unsubscribe = subscription.unsubscribe
        }
      },
      () => {}
    )
    return () => {
      disposed = true
      projector.dispose()
      unsubscribe()
    }
  }, [roomId, target])

  useEffect(() => {
    if (!roomId || state.snapshot?.deliveryQueueVersion !== 1) {
      return
    }
    let disposed = false
    void roomRpc<{
      queue: Pick<RoomMessagePage, 'messages' | 'deliveries'>
    }>(target, 'rooms.deliveries.queue', { roomId }).then(
      ({ queue }) => {
        if (!disposed) {
          dispatch({ type: 'local.messages.loaded', ...queue })
        }
      },
      (cause) => !disposed && setError(message(cause))
    )
    return () => {
      disposed = true
    }
  }, [roomId, state.snapshot?.deliveryQueueVersion, target])

  useEffect(() => {
    if (!roomId) {
      return
    }
    let disposed = false
    dispatch({ type: 'local.messages.cleared' })
    historyCursorRef.current = { roomId, beforeSequence: null }
    setHasMore(false)
    void roomRpc<{ page: RoomMessagePage }>(target, 'rooms.messages.list', {
      roomId,
      beforeSequence: null,
      limit: 100
    }).then(
      ({ page }) => {
        if (disposed) {
          return
        }
        dispatch({
          type: 'local.messages.loaded',
          messages: page.messages,
          deliveries: page.deliveries
        })
        historyCursorRef.current = { roomId, beforeSequence: page.beforeSequence }
        setHasMore(page.hasMore)
      },
      (cause) => setError(message(cause))
    )
    return () => {
      disposed = true
    }
  }, [roomId, target])

  const loadOlder = useCallback(async () => {
    const cursor = historyCursorRef.current
    if (
      !roomId ||
      cursor?.roomId !== roomId ||
      cursor.beforeSequence === null ||
      !hasMore ||
      loadingOlderRef.current
    ) {
      return
    }
    loadingOlderRef.current = true
    try {
      const requestedRoom = roomId
      const { page } = await roomRpc<{ page: RoomMessagePage }>(target, 'rooms.messages.list', {
        roomId,
        beforeSequence: cursor.beforeSequence,
        limit: 100
      })
      if (roomIdRef.current !== requestedRoom) {
        return
      }
      dispatch({
        type: 'local.messages.loaded',
        messages: page.messages,
        deliveries: page.deliveries
      })
      historyCursorRef.current = { roomId, beforeSequence: page.beforeSequence }
      setHasMore(page.hasMore)
    } finally {
      loadingOlderRef.current = false
    }
  }, [hasMore, roomId, target])

  return useMemo(
    () => ({
      ...state,
      steerDelivery,
      pendingSteerIds,
      rooms,
      roomId,
      loading,
      error,
      hasMore,
      readerKey,
      target,
      loadOlder
    }),
    [
      state,
      rooms,
      roomId,
      loading,
      error,
      hasMore,
      readerKey,
      target,
      loadOlder,
      steerDelivery,
      pendingSteerIds
    ]
  )
}

export type RoomData = ReturnType<typeof useRoomData>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function updateSnapshotRef(snapshot: RoomSnapshot | null, event: RoomEvent): RoomSnapshot | null {
  if (event.type === 'snapshot') {
    return event.snapshot
  }
  if (!snapshot) {
    return null
  }
  return reduceRoomEvent(
    { snapshot, messages: [], deliveries: {}, activities: {}, lastSteeredParticipantId: null },
    event
  ).snapshot
}
