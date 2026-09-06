// @vitest-environment happy-dom
import { useState } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RoomDelivery, RoomParticipant } from '../../../../shared/rooms'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { QueuedMessageCardProps } from '../native-chat/QueuedMessageCard'
import type { RoomData } from './use-room-data'
import { useRoomSteerRequests } from './use-room-steer-requests'
import { RoomDirectedQueueRow } from './RoomQueueRows'
import { roomDirectedQueueItems, roomSharedQueueItems } from './room-queue-items'
import { computeRoomQueueState } from './room-queue-state'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }))
vi.mock('@/runtime/runtime-rooms-client', () => ({ roomRpc: mocks.rpc }))
vi.mock('./RoomQueuedMessageCard', () => ({
  RoomQueuedMessageCard: ({ item, onSteer }: QueuedMessageCardProps) => (
    <div>
      <span>{item.detail}</span>
      <button disabled={item.state === 'submitting'} onClick={onSteer}>
        Steer
      </button>
    </div>
  )
}))

const LOCAL = { kind: 'local' } as const
const REMOTE = { kind: 'environment', environmentId: 'remote-1' } as const
const delivery = {
  id: 'd1',
  messageId: 'm1',
  participantId: 'p1',
  state: 'pending',
  attempts: 0,
  intent: 'next',
  error: null
} as RoomDelivery
const participant = {
  id: 'p1',
  roomId: 'r1',
  identity: 'codex',
  actorKind: 'agent',
  participation: 'active',
  state: 'busy',
  providerSession: { transport: 'machine' }
} as RoomParticipant
const feedback = 'Steering to the agent…'

function dataFor(
  deliveries: Record<string, RoomDelivery>,
  requests: ReturnType<typeof useRoomSteerRequests>
): RoomData {
  return {
    ...requests,
    roomId: 'r1',
    target: LOCAL,
    deliveries,
    snapshot: {
      participants: [participant],
      workState: 'running',
      deliveryQueueMutationVersion: 1,
      deliveryQueueVersion: 1
    },
    messages: [{ id: 'm1', roomId: 'r1', actorKind: 'user', body: 'continue', attachments: [] }]
  } as unknown as RoomData
}

function Room({ current = delivery }: { current?: RoomDelivery }) {
  const [open, setOpen] = useState(true)
  const deliveries = { [current.id]: current }
  const requests = useRoomSteerRequests(LOCAL, 'r1', deliveries)
  const data = dataFor(deliveries, requests)
  const item = roomDirectedQueueItems(data, participant, [current])[0]!
  return (
    <>
      <button onClick={() => setOpen(!open)}>Toggle queue</button>
      {open && current.state !== 'delivered' && (
        <RoomDirectedQueueRow data={data} item={item} participantId="p1" report={mocks.report} />
      )}
    </>
  )
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

it('retains pending feedback across overlay remount and an RPC reply preceding delivery.updated', async () => {
  const rpc = deferred()
  mocks.rpc.mockReturnValue(rpc.promise)
  const view = render(<Room />)
  fireEvent.click(screen.getByText('Steer'))
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
  expect(screen.getByText(feedback)).toBeTruthy()
  fireEvent.click(screen.getByText('Toggle queue'))
  fireEvent.click(screen.getByText('Toggle queue'))
  expect(screen.getByText(feedback)).toBeTruthy()
  expect((screen.getByText('Steer') as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    rpc.resolve()
    await rpc.promise
  })
  expect(screen.getByText(feedback)).toBeTruthy()
  view.rerender(
    <Room current={{ ...delivery, state: 'delivering', intent: 'steer', attempts: 1 }} />
  )
  expect(screen.getByText(feedback)).toBeTruthy()
  view.rerender(
    <Room current={{ ...delivery, state: 'delivered', intent: 'steer', attempts: 1 }} />
  )
  expect(screen.queryByText(feedback)).toBeNull()
})

it('clears failed requests and permits an explicit retry after reopening', async () => {
  const rpc = deferred()
  mocks.rpc.mockReturnValue(rpc.promise)
  render(<Room />)
  fireEvent.click(screen.getByText('Steer'))
  await act(async () => {
    rpc.reject(new Error('refused'))
    await rpc.promise.catch(() => {})
  })
  expect(mocks.report).toHaveBeenCalledOnce()
  expect(screen.queryByText(feedback)).toBeNull()
  expect((screen.getByText('Steer') as HTMLButtonElement).disabled).toBe(false)
})

it('deduplicates before React renders and isolates late replies by room and execution target', async () => {
  const old = deferred(),
    next = deferred()
  mocks.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const hook = renderHook(
    ({ roomId, target }: { roomId: string; target: RuntimeClientTarget }) =>
      useRoomSteerRequests(target, roomId, { d1: delivery }),
    { initialProps: { roomId: 'r1', target: LOCAL as RuntimeClientTarget } }
  )
  let first!: Promise<void>, duplicate!: Promise<void>
  act(() => {
    first = hook.result.current.steerDelivery(['d1'])
    duplicate = hook.result.current.steerDelivery(['d1'])
  })
  expect(first).toBe(duplicate)
  void first.catch(() => {})
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
  hook.rerender({ roomId: 'r2', target: REMOTE })
  expect(hook.result.current.pendingSteerIds.size).toBe(0)
  act(() => {
    void hook.result.current.steerDelivery(['d1'])
  })
  await act(async () => {
    old.reject(new Error('old failure'))
    await first.catch(() => {})
  })
  expect(hook.result.current.pendingSteerIds.has('d1')).toBe(true)
  await act(async () => {
    next.resolve()
    await next.promise
  })
})

it('keeps shared requests visible and lets Stop override optimistic feedback', async () => {
  const rpc = deferred()
  mocks.rpc.mockReturnValue(rpc.promise)
  const hook = renderHook(() => useRoomSteerRequests(REMOTE, 'r1', { d1: delivery }))
  act(() => {
    void hook.result.current.steerDelivery(['d1'], true)
  })
  const data = dataFor({ d1: delivery }, hook.result.current)
  const state = computeRoomQueueState(data)!
  expect(roomSharedQueueItems(data, state)[0]).toMatchObject({
    state: 'submitting',
    canEdit: false,
    canRemove: false
  })
  data.snapshot = { ...data.snapshot!, workState: 'stopped' }
  expect(roomDirectedQueueItems(data, participant, [delivery])[0]).toMatchObject({
    state: 'paused',
    detail: undefined,
    canSteer: false
  })
  await act(async () => {
    rpc.resolve()
    await rpc.promise
  })
  expect(mocks.rpc).toHaveBeenCalledWith(REMOTE, 'rooms.deliveries.steer', {
    deliveryId: 'd1',
    group: true
  })
})
