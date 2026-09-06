// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMessage, RoomMessagePage, RoomSnapshot } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useRoomData } from './use-room-data'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/runtime-rooms-client', () => ({
  roomRpc: mocks.rpc,
  subscribeRoom: mocks.subscribe
}))

describe('useRoomData history pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the history cursor independent from older paused queue messages', async () => {
    const target = { kind: 'local' } as const
    const initial = deferred<{ page: RoomMessagePage }>()
    const queue = deferred<{ queue: Pick<RoomMessagePage, 'messages' | 'deliveries'> }>()
    mocks.subscribe.mockImplementation(
      async (
        _target: RuntimeClientTarget,
        roomId: string,
        _readerKey: string,
        onEvent: (event: { type: 'snapshot'; snapshot: RoomSnapshot }) => void
      ) => {
        onEvent({ type: 'snapshot', snapshot: snapshot(roomId) })
        return { unsubscribe: vi.fn() }
      }
    )
    mocks.rpc.mockImplementation(
      async (
        _target: RuntimeClientTarget,
        method: string,
        params: { beforeSequence?: number | null }
      ) => {
        if (method === 'rooms.list') {
          return { rooms: [] }
        }
        if (method === 'rooms.deliveries.queue') {
          return queue.promise
        }
        if (method === 'rooms.messages.list' && params.beforeSequence === null) {
          return initial.promise
        }
        if (method === 'rooms.messages.list') {
          return {
            page: {
              messages: [message('older', 100)],
              deliveries: [],
              hasMore: false,
              beforeSequence: null
            }
          }
        }
        throw new Error(`unexpected_rpc:${method}`)
      }
    )
    const hook = renderHook(() => useRoomData(target, 'project-1', 'room-1'))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'rooms.deliveries.queue',
        expect.anything()
      )
    )

    await act(async () => {
      queue.resolve({ queue: { messages: [message('paused', 50)], deliveries: [] } })
      await queue.promise
    })
    await act(async () => {
      initial.resolve({
        page: {
          messages: [message('first', 101), message('latest', 200)],
          deliveries: [],
          hasMore: true,
          beforeSequence: 101
        }
      })
      await initial.promise
    })
    await waitFor(() => expect(hook.result.current.hasMore).toBe(true))
    expect(hook.result.current.messages[0]?.sequence).toBe(50)

    await act(async () => hook.result.current.loadOlder())
    expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'rooms.messages.list', {
      roomId: 'room-1',
      beforeSequence: 101,
      limit: 100
    })
  })
})

function message(id: string, sequence: number): RoomMessage {
  return { id, roomId: 'room-1', sequence } as RoomMessage
}

function snapshot(roomId: string): RoomSnapshot {
  return {
    room: { id: roomId },
    roles: [],
    participants: [],
    activities: [],
    pins: [],
    unread: { unreadCount: 0 },
    deliveryQueueVersion: 1
  } as unknown as RoomSnapshot
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
