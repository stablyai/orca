import { Agent, type ClientRequestArgs } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'
import type { PairingOffer, PairingTunnel } from './mobile-relay-pairing-offer'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'

export const TUNNEL_DIALER_UNAVAILABLE_MESSAGE =
  'This server is shared over Tailcat. Install the tailcat CLI on this computer to connect.'

/** Opens a raw TCP stream to the runtime's WebSocket port through the tunnel named in a pairing offer. */
export type RemoteRuntimeTunnelDialer = (tunnel: PairingTunnel) => Promise<Socket>

// Why process-global: the shared client runs in Electron main and the CLI, and neither can import the
// process that owns the tunnel helper. Each host registers its dialer once at startup; a host that
// never does (the browser bundle, a CLI without tailcat) keeps dialing the plain endpoint.
let registeredDialer: RemoteRuntimeTunnelDialer | null = null

export function setRemoteRuntimeTunnelDialer(dialer: RemoteRuntimeTunnelDialer | null): void {
  registeredDialer = dialer
}

export function getRemoteRuntimeTunnelDialer(): RemoteRuntimeTunnelDialer | null {
  return registeredDialer
}

type CreateConnectionCallback = (error: Error | null, stream: Duplex) => void

/**
 * `http.Agent` whose sockets come from the tunnel instead of `net.connect`.
 *
 * Why an agent and not ws's `createConnection` option: the tunnel handshake is
 * asynchronous, and the agent's `createConnection(options, callback)` form is the
 * documented way to hand `http.request` a socket that is not ready yet.
 */
export class RemoteRuntimeTunnelAgent extends Agent {
  constructor(
    private readonly tunnel: PairingTunnel,
    private readonly dial: RemoteRuntimeTunnelDialer
  ) {
    super({ keepAlive: false })
  }

  createConnection(
    _options: ClientRequestArgs,
    callback?: CreateConnectionCallback
  ): Duplex | null | undefined {
    if (!callback) {
      throw new Error(
        'RemoteRuntimeTunnelAgent only supports the callback form of createConnection'
      )
    }
    this.dial(this.tunnel).then(
      (socket) => callback(null, socket),
      // Why: Node reads only the error argument on failure; the typing still demands a stream slot.
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          null as unknown as Duplex
        )
    )
    return undefined
  }
}

/**
 * The one place a pairing offer becomes a socket. Every remote runtime dial must come through here,
 * or a tunnel-only host is dialed at an address nothing can reach.
 *
 * Throws a `RemoteRuntimeClientError` when the offer needs a tunnel, no dialer is registered, and
 * the fallback address is the host's own loopback.
 */
export function createRemoteRuntimeWebSocket(
  pairing: PairingOffer,
  options: WebSocket.ClientOptions = {}
): WebSocket {
  const dialer = pairing.tunnel ? getRemoteRuntimeTunnelDialer() : null
  if (pairing.tunnel && !dialer && isLoopbackEndpoint(pairing.endpoint)) {
    throw remoteRuntimeUnavailableError(TUNNEL_DIALER_UNAVAILABLE_MESSAGE)
  }
  return new WebSocket(
    pairing.endpoint,
    pairing.tunnel && dialer
      ? { ...options, agent: new RemoteRuntimeTunnelAgent(pairing.tunnel, dialer) }
      : options
  )
}

/** Adds the socket's own failure reason for tunnel dials, where the endpoint explains nothing. */
export function describeRemoteRuntimeSocketError(pairing: PairingOffer, error: Error): string {
  const detail = pairing.tunnel && error.message ? ` ${error.message}` : ''
  return `Could not connect to the remote Orca runtime.${detail}`
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return classifyRemotePairingHostname(new URL(endpoint).hostname) === 'loopback'
  } catch {
    return false
  }
}

/** Normalizes a `createRemoteRuntimeWebSocket` failure: tunnel refusals pass through, URL errors wrap. */
export function remoteRuntimeSocketCreationError(error: unknown): RemoteRuntimeClientError {
  if (error instanceof RemoteRuntimeClientError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
}
