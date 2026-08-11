import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Room, RoomEvent, RoomMessagePage, RoomSnapshot } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { roomRpc, subscribeRoom } from '@/runtime/runtime-rooms-client'
import { EMPTY_ACTIVE_ROOM, reduceRoomEvent } from './room-event-reducer'
import { useRoomTabs } from './use-room-tabs'

export function useRoomData(
  target: RuntimeClientTarget,
  projectId: string | null,
  roomId: string | null
) {
  const [rooms, setRooms] = useState<Room[]>([])
  useRoomTabs(rooms)
  const [state, dispatch] = useReducer(reduceRoomEvent, EMPTY_ACTIVE_ROOM)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readerKey = 'user'
  const snapshotRef = useRef<RoomSnapshot | null>(null)
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
        projectId,
        includeArchived: true
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
    void subscribeRoom(
      target,
      roomId,
      readerKey,
      (event) => {
        if (disposed || event.type === 'end') {
          return
        }
        snapshotRef.current = updateSnapshotRef(snapshotRef.current, event)
        dispatch(event)
        if (event.type === 'room.updated') {
          setRooms((current) =>
            current.map((room) => (room.id === event.room.id ? event.room : room))
          )
        }
      },
      (cause) => {
        if (!disposed) {
          setError(message(cause))
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
      unsubscribe()
    }
  }, [roomId, target])

  useEffect(() => {
    if (!roomId) {
      return
    }
    let disposed = false
    dispatch({ type: 'local.messages.cleared' })
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
        setHasMore(page.hasMore)
      },
      (cause) => setError(message(cause))
    )
    return () => {
      disposed = true
    }
  }, [roomId, target])

  const loadOlder = useCallback(async () => {
    const beforeSequence = state.messages[0]?.sequence
    if (!roomId || !beforeSequence || !hasMore || loadingOlderRef.current) {
      return
    }
    loadingOlderRef.current = true
    try {
      const requestedRoom = roomId
      const { page } = await roomRpc<{ page: RoomMessagePage }>(target, 'rooms.messages.list', {
        roomId,
        beforeSequence,
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
      setHasMore(page.hasMore)
    } finally {
      loadingOlderRef.current = false
    }
  }, [hasMore, roomId, state.messages, target])

  return useMemo(
    () => ({
      ...state,
      rooms,
      roomId,
      loading,
      error,
      hasMore,
      readerKey,
      target,
      loadOlder
    }),
    [state, rooms, roomId, loading, error, hasMore, readerKey, target, loadOlder]
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
  return reduceRoomEvent({ snapshot, messages: [], deliveries: {}, activities: {} }, event).snapshot
}
