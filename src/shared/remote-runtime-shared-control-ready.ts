import WebSocket from 'ws'
import { abortSignalReason } from './abort-signal-reason'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { REMOTE_RUNTIME_MAX_READY_WAITERS } from './remote-runtime-memory-limits'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import type {
  SharedControlConnectionState,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'

export function isSharedControlReady(args: {
  state: SharedControlConnectionState
  ws: WebSocket | null
  sharedKey: Uint8Array | null
}): boolean {
  return args.state === 'ready' && args.ws?.readyState === WebSocket.OPEN && !!args.sharedKey
}

export function openIfSocketClosed(ws: WebSocket | null, open: () => void): void {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    open()
  }
}

export function waitForSharedControlReadyWithTimeout(args: {
  readyWaiters: SharedControlReadyWaiter[]
  timeoutMs: number
  open: () => void
  signal?: AbortSignal
}): Promise<void> {
  if (args.signal?.aborted) {
    return Promise.reject(abortSignalReason(args.signal))
  }
  if (args.readyWaiters.length >= REMOTE_RUNTIME_MAX_READY_WAITERS) {
    return Promise.reject(
      new RemoteRuntimeClientError(
        'remote_runtime_busy',
        'Remote runtime connection wait limit reached; retry after pending work finishes.'
      )
    )
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let waiter!: SharedControlReadyWaiter
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      const index = args.readyWaiters.indexOf(waiter)
      if (index !== -1) {
        args.readyWaiters.splice(index, 1)
      }
      args.signal?.removeEventListener('abort', onAbort)
      reject(remoteRuntimeUnavailableError())
    }, args.timeoutMs)
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      const index = args.readyWaiters.indexOf(waiter)
      if (index !== -1) {
        args.readyWaiters.splice(index, 1)
      }
      reject(abortSignalReason(args.signal!))
    }
    waiter = {
      resolve: () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        args.signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      reject: (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        args.signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    }
    args.readyWaiters.push(waiter)
    args.signal?.addEventListener('abort', onAbort, { once: true })
    if (args.signal?.aborted) {
      onAbort()
      return
    }
    try {
      args.open()
    } catch (error) {
      const index = args.readyWaiters.indexOf(waiter)
      if (index !== -1) {
        args.readyWaiters.splice(index, 1)
      }
      waiter.reject(error instanceof Error ? error : remoteRuntimeUnavailableError(String(error)))
    }
  })
}
