import type {
  BrowserNetworkTunnelClientSocket,
  BrowserNetworkTunnelClientSocketCallbacks
} from './browser-network-tunnel-client-socket'
import type { BrowserNetworkTunnelSourceFlowStream } from './browser-network-tunnel-source-flow'
import type { BrowserNetworkTunnelSourceReceiveStream } from './browser-network-tunnel-source-receive-flow'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
} from './browser-network-tunnel-stream-state'

export type BrowserNetworkTunnelClientStream = BrowserNetworkTunnelSourceFlowStream &
  BrowserNetworkTunnelSourceReceiveStream & {
    id: number
    socket: BrowserNetworkTunnelClientSocket
    closed: boolean
    localEnded: boolean
    localHalfCloseSent: boolean
    remoteClosed: boolean
    connectTimeout: ReturnType<typeof setTimeout>
    resolveOpen: () => void
    rejectOpen: (error: Error) => void
  }

type BrowserNetworkTunnelClientStreamCallbacks = BrowserNetworkTunnelClientSocketCallbacks & {
  onConnectTimeout: (stream: BrowserNetworkTunnelClientStream) => void
}

export function createBrowserNetworkTunnelClientStream<
  Socket extends BrowserNetworkTunnelClientSocket
>(
  id: number,
  createSocket: (callbacks: BrowserNetworkTunnelClientSocketCallbacks) => Socket,
  callbacks: BrowserNetworkTunnelClientStreamCallbacks
): { stream: BrowserNetworkTunnelClientStream; opening: Promise<Socket> } {
  let resolveOpen = (): void => {}
  let rejectOpen = (_error: Error): void => {}
  const opening = new Promise<Socket>((resolve, reject) => {
    resolveOpen = () => resolve(socket)
    rejectOpen = reject
  })
  const socket = createSocket(callbacks)
  const stream: BrowserNetworkTunnelClientStream = {
    id,
    socket,
    opened: false,
    closed: false,
    localEnded: false,
    localHalfCloseSent: false,
    remoteEnded: false,
    remoteClosed: false,
    readableEnded: false,
    sendCredit: 0,
    receiveCredit: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    pendingToSocket: [],
    pendingToSocketBytes: 0,
    unsettledToSocket: [],
    readableDemand: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
    connectTimeout: setTimeout(
      () => callbacks.onConnectTimeout(stream),
      BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    ),
    resolveOpen,
    rejectOpen
  }
  return { stream, opening }
}
