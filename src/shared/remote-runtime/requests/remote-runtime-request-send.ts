import WebSocket from 'ws'
import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import type { RemoteRuntimeOrdinarySender } from '../remote-runtime-ordinary-sender'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import {
  takeRemoteRuntimePreparedRequest,
  toRemoteRuntimeRequestError,
  type RemoteRuntimePendingRequest
} from './remote-runtime-prepared-request-admission'

export async function sendRemoteRuntimeRequest(args: {
  requestId: string
  ready: boolean
  ws: WebSocket | null
  handshake: PairedE2EEClientHandshake | null
  ordinary: RemoteRuntimeOrdinarySender
  pending: Map<string, RemoteRuntimePendingRequest<unknown>>
  probe: () => Promise<unknown>
  reject: (id: string, error: Error) => void
}): Promise<void> {
  const held = args.pending.get(args.requestId)
  if (!held) {
    return
  }
  if (!args.ready || !args.ws || args.ws.readyState !== WebSocket.OPEN || !args.handshake) {
    args.reject(args.requestId, remoteRuntimeUnavailableError())
    return
  }
  const json = takeRemoteRuntimePreparedRequest(held)
  if (json === null) {
    args.reject(args.requestId, remoteRuntimeUnavailableError())
    return
  }
  try {
    const admission = args.ordinary.admit(json, args.ws, args.probe, () =>
      args.pending.has(args.requestId)
    )
    if (admission !== true && !(await admission)) {
      return
    }
    if (!args.ordinary.send(json, args.ws, args.handshake, true)) {
      throw remoteRuntimeUnavailableError()
    }
  } catch (error) {
    args.reject(args.requestId, toRemoteRuntimeRequestError(error))
  }
}
