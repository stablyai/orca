import WebSocket from 'ws'
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

export function waitForSharedControlReadyWithTimeout(args: {
  readyWaiters: SharedControlReadyWaiter[]
  timeoutMs: number
  open: () => void
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let waiter!: SharedControlReadyWaiter
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      const index = args.readyWaiters.indexOf(waiter)
      if (index >= 0) {
        args.readyWaiters.splice(index, 1)
      }
      reject(remoteRuntimeUnavailableError())
    }, args.timeoutMs)
    waiter = {
      resolve: () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        resolve()
      },
      reject: (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    }
    args.readyWaiters.push(waiter)
    args.open()
  })
}
