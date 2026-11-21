import WebSocket from 'ws'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessMonitor
} from '../remote-runtime-socket-liveness'

/** A long poll is silent until it settles, so only pings can tell a quiet host from a dead path. */
export function startRemoteRuntimeRequestSocketLiveness(args: {
  getSocket: () => WebSocket | null
  getPairingStage: () => RemoteRuntimeClientError['pairingStage']
  onLost: (error: RemoteRuntimeClientError) => void
}): RemoteRuntimeSocketLivenessMonitor {
  return startRemoteRuntimeSocketLiveness({
    ping: () => {
      const ws = args.getSocket()
      if (ws?.readyState !== WebSocket.OPEN) {
        return false
      }
      ws.ping()
      return true
    },
    onDead: () => {
      // close() waits for a close frame that a dead path never delivers.
      args.getSocket()?.terminate()
      args.onLost(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Remote Orca runtime connection closed: the connection was lost (keepalive pings went unanswered).',
          { pairingStage: args.getPairingStage() }
        )
      )
    }
  })
}
