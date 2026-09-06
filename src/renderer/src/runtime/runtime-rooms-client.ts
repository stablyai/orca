import type { RoomEvent, RoomSnapshot } from '../../../shared/rooms'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from './runtime-client-target'

export type RoomSubscription = { unsubscribe: () => void }

export function roomRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
): Promise<TResult> {
  return callRuntimeRpc<TResult>(target, method, params)
}

export async function subscribeRoom(
  target: RuntimeClientTarget,
  roomId: string,
  readerKey: string,
  onEvent: (event: RoomEvent) => void,
  onError: (error: unknown) => void = console.warn
): Promise<RoomSubscription> {
  if (target.kind === 'local') {
    return subscribeLocalRoom(target, roomId, readerKey, onEvent, onError)
  }
  const handle = await window.api.runtimeEnvironments.subscribe(
    {
      selector: target.environmentId,
      method: 'rooms.subscribe',
      params: { roomId, readerKey, subscriptionId: crypto.randomUUID() },
      timeoutMs: 15_000
    },
    {
      onResponse: (response) => handleRoomResponse(response, onEvent, onError),
      onError
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

async function subscribeLocalRoom(
  target: RuntimeClientTarget,
  roomId: string,
  readerKey: string,
  onEvent: (event: RoomEvent) => void,
  onError: (error: unknown) => void
): Promise<RoomSubscription> {
  const queued: RoomEvent[] = []
  let ready = false
  const unsubscribe = window.api.runtime.onRoomEvent(({ roomId: eventRoomId, event }) => {
    if (eventRoomId !== roomId) {
      return
    }
    if (ready) {
      onEvent(event)
    } else {
      queued.push(event)
    }
  })
  try {
    const { snapshot } = await roomRpc<{ snapshot: RoomSnapshot }>(target, 'rooms.snapshot', {
      roomId,
      readerKey
    })
    onEvent({ type: 'snapshot', snapshot })
    ready = true
    for (const event of queued) {
      onEvent(event)
    }
    return { unsubscribe }
  } catch (error) {
    unsubscribe()
    onError(error)
    throw error
  }
}

function handleRoomResponse(
  response: RuntimeRpcResponse<unknown>,
  onEvent: (event: RoomEvent) => void,
  onError: (error: unknown) => void
): void {
  if (!response.ok) {
    onError(response.error)
    return
  }
  onEvent(response.result as RoomEvent)
}
