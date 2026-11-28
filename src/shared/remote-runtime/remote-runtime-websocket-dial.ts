import type { ClientRequestArgs } from 'node:http'
import { connect as connectTcp, isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as connectTls, type ConnectionOptions } from 'node:tls'
import WebSocket, { type ClientOptions } from 'ws'
import type { BrowserNetworkTunnelOpen } from '../browser/network/tunnels/browser-network-tunnel-protocol'
import { openConnectedSocket } from '../../main/browser/network/tunnels/browser-network-connected-socket'
import { connectThroughBrowserNetworkTunnelProxy } from '../../main/browser/network/tunnels/browser-network-tunnel-proxy-connect'
import { openExecutionRouteSocketAsDuplex } from '../../main/browser/network/tunnels/execution-route-socket-duplex'
import {
  REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
  WS_HANDSHAKE_TIMEOUT_MESSAGE,
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions,
  type RemoteRuntimeDialProxy
} from './remote-runtime-connect-bound'
import {
  remoteRuntimeEndpointNeedsProxySelection,
  remoteRuntimeProxyKindName,
  selectRemoteRuntimeProxy,
  type RemoteRuntimeProxySelection
} from './remote-runtime-proxy-selection'

type DialRoute = { proxy: RemoteRuntimeDialProxy | null }
type HttpConnectionOptions = ClientRequestArgs & ConnectionOptions
type OnCreate = (error: Error | null, socket?: Duplex) => void

const dialRoutes = new WeakMap<WebSocket, DialRoute>()

class RemoteRuntimeProxyFailure extends Error {}

/** Opens a paired-Runtime WebSocket, picking the proxy afresh for this dial. */
export function createRemoteRuntimeWebSocket(
  endpoint: string,
  options: ClientOptions,
  connectTimeoutMs?: number
): WebSocket {
  const connectOptions = remoteRuntimeConnectOptions(options, connectTimeoutMs)
  let url: URL | null = null
  try {
    url = new URL(endpoint)
  } catch {
    // Let ws report the malformed endpoint in its own words.
  }
  if (!url || !remoteRuntimeEndpointNeedsProxySelection(url)) {
    return new WebSocket(endpoint, connectOptions)
  }
  const route: DialRoute = { proxy: null }
  const endpointUrl = url
  const createConnection = (httpOptions: HttpConnectionOptions, oncreate: OnCreate): undefined => {
    dialRemoteRuntimeEndpoint(endpointUrl, httpOptions, route).then(
      (socket) => oncreate(null, socket),
      (error: unknown) => oncreate(error instanceof Error ? error : new Error(String(error)))
    )
    return undefined
  }
  const ws = new WebSocket(endpoint, {
    ...connectOptions,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws hands this to http.request, whose createConnection may deliver the socket through the callback; ws's typings only name the synchronous net.createConnection form.
    createConnection: createConnection as unknown as ClientOptions['createConnection']
  })
  dialRoutes.set(ws, route)
  return ws
}

/** The proxy this socket's dial went through, for failure messages; null for a direct dial. */
export function remoteRuntimeDialProxy(
  ws: WebSocket | null | undefined
): RemoteRuntimeDialProxy | null {
  return (ws && dialRoutes.get(ws)?.proxy) ?? null
}

async function dialRemoteRuntimeEndpoint(
  endpoint: URL,
  httpOptions: HttpConnectionOptions,
  route: DialRoute
): Promise<Duplex> {
  const deadline =
    Date.now() +
    (typeof httpOptions.timeout === 'number' && httpOptions.timeout > 0
      ? httpOptions.timeout
      : REMOTE_RUNTIME_CONNECT_TIMEOUT_MS)
  // ws strips IPv6 brackets and fills in the default port.
  const target: BrowserNetworkTunnelOpen = {
    host: String(httpOptions.host),
    port: Number(httpOptions.port)
  }
  const selection = await beforeDeadline(selectRemoteRuntimeProxy(endpoint, target), deadline)
  if (selection.proxy.kind === 'direct') {
    return connectEndpointDirectly(endpoint, httpOptions, target.host)
  }
  const proxy: RemoteRuntimeDialProxy = { label: selection.label ?? 'proxy', failure: null }
  route.proxy = proxy
  try {
    const tunnel = await openProxyTunnel(selection, target, deadline)
    return endpoint.protocol === 'wss:' ? wrapEndpointTls(tunnel, httpOptions, target.host) : tunnel
  } catch (error) {
    if (error instanceof Error && error.message === WS_HANDSHAKE_TIMEOUT_MESSAGE) {
      throw error
    }
    proxy.failure = describeProxyFailure(error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

async function openProxyTunnel(
  selection: RemoteRuntimeProxySelection,
  target: BrowserNetworkTunnelOpen,
  deadline: number
): Promise<Duplex> {
  const { proxy } = selection
  if (proxy.kind === 'unsupported') {
    throw new RemoteRuntimeProxyFailure(
      `the proxy kind ${remoteRuntimeProxyKindName(proxy.protocol)} is not supported; use an HTTP or SOCKS5 proxy`
    )
  }
  if (proxy.kind === 'socks5' && (proxy.url.username || proxy.url.password)) {
    throw new RemoteRuntimeProxyFailure(
      'a SOCKS5 proxy with a user name and password is not supported'
    )
  }
  const socket = connectThroughBrowserNetworkTunnelProxy(target, proxy, {
    connect: (direct) => connectTcp(direct),
    openTransport: openConnectedSocket
  })
  try {
    return await openExecutionRouteSocketAsDuplex(socket, {
      connectTimeoutMs: Math.max(1, deadline - Date.now())
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'browser_local_route_connect_timeout') {
      throw new Error(WS_HANDSHAKE_TIMEOUT_MESSAGE)
    }
    throw error
  }
}

// Same as ws's own connectors, which this dial replaces.
function connectEndpointDirectly(
  endpoint: URL,
  httpOptions: HttpConnectionOptions,
  host: string
): Duplex {
  if (endpoint.protocol === 'wss:') {
    return connectTls({
      ...httpOptions,
      path: undefined,
      servername: httpOptions.servername ?? (isIP(host) ? '' : host)
    })
  }
  return connectTcp({ ...httpOptions, host, port: Number(httpOptions.port) })
}

/** TLS runs end to end inside the tunnel, so SNI and the certificate check use the endpoint's host. */
function wrapEndpointTls(tunnel: Duplex, httpOptions: HttpConnectionOptions, host: string): Duplex {
  return connectTls({
    ...httpOptions,
    path: undefined,
    socket: tunnel,
    host,
    servername: httpOptions.servername ?? (isIP(host) ? '' : host)
  })
}

function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(WS_HANDSHAKE_TIMEOUT_MESSAGE)),
      Math.max(1, deadline - Date.now())
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT'
])

/** Fixed wording only: tunnel errors may echo proxy replies, which must not reach a message. */
function describeProxyFailure(error: unknown): string {
  if (error instanceof RemoteRuntimeProxyFailure) {
    return error.message
  }
  const message = error instanceof Error ? error.message : ''
  const status = /^http_proxy_connect_rejected:(\d{3})$/.exec(message)?.[1]
  if (status) {
    return `the proxy refused the tunnel (HTTP ${status})`
  }
  if (message.startsWith('http_proxy_')) {
    return 'the proxy sent an invalid reply'
  }
  if (message === 'system_ssh_socks_auth_rejected') {
    return 'the SOCKS5 proxy requires a login'
  }
  if (message === 'system_ssh_socks_connect_rejected') {
    return 'the SOCKS5 proxy refused the connection'
  }
  if (message.startsWith('system_ssh_socks_')) {
    return 'the SOCKS5 proxy sent an invalid reply'
  }
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return 'the proxy could not be reached'
  }
  return 'the proxy closed the connection'
}

/** Formats a socket connect failure with the proxy that handled this dial, when one did. */
export function remoteRuntimeSocketConnectFailureMessage(
  error: unknown,
  endpoint: string,
  ws: WebSocket | null | undefined
): string {
  return remoteRuntimeConnectFailureMessage(error, endpoint, remoteRuntimeDialProxy(ws))
}
