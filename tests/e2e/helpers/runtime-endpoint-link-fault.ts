import net from 'node:net'
import { decodePairingOffer, encodePairingOffer } from '../../../src/shared/pairing'

/**
 * A TCP hop in front of a paired runtime's WebSocket endpoint whose fault mode can
 * change mid-test.
 *
 * `stall-new` is the Tailscale-shaped fault this exists for: already-established
 * flows keep delivering while a freshly dialed connection hangs unanswered. That
 * asymmetry is what separates "the control plane could not ask" from "the runtime
 * is gone", and neither killing the runtime nor `runtimeEnvironments.disconnect`
 * can produce it — both take the two halves down together.
 */
export type RuntimeLinkFaultMode = 'pass' | 'stall-new'

export type RuntimeEndpointLinkFault = {
  /** ws:// endpoint that routes through this hop. */
  endpoint: string
  setMode: (mode: RuntimeLinkFaultMode) => void
  /** Connections accepted since the last reset — proves a dial actually reached the hop. */
  acceptedConnectionCount: () => number
  stalledConnectionCount: () => number
  resetCounters: () => void
  close: () => Promise<void>
}

function parseWsEndpoint(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint)
  return { host: url.hostname, port: Number(url.port) }
}

export async function startRuntimeEndpointLinkFault(
  upstreamEndpoint: string
): Promise<RuntimeEndpointLinkFault> {
  const upstream = parseWsEndpoint(upstreamEndpoint)
  let mode: RuntimeLinkFaultMode = 'pass'
  let accepted = 0
  let stalledTotal = 0
  const stalled = new Set<net.Socket>()
  const live = new Set<net.Socket>()

  const server = net.createServer((client) => {
    accepted += 1
    live.add(client)
    client.on('close', () => live.delete(client))
    client.on('error', () => client.destroy())
    if (mode === 'stall-new') {
      // Accept the TCP handshake and answer nothing: the dialer waits out its own
      // timeout, as it does on a half-open path, instead of failing fast on reset.
      stalledTotal += 1
      stalled.add(client)
      client.on('close', () => stalled.delete(client))
      return
    }
    const upstreamSocket = net.connect(upstream.port, upstream.host)
    live.add(upstreamSocket)
    upstreamSocket.on('close', () => live.delete(upstreamSocket))
    upstreamSocket.on('error', () => client.destroy())
    client.pipe(upstreamSocket)
    upstreamSocket.pipe(client)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('runtime endpoint link fault did not bind a TCP port')
  }

  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    setMode: (next) => {
      mode = next
      if (next === 'pass') {
        for (const socket of stalled) {
          socket.destroy()
        }
        stalled.clear()
      }
    },
    acceptedConnectionCount: () => accepted,
    stalledConnectionCount: () => stalledTotal,
    resetCounters: () => {
      accepted = 0
      stalledTotal = 0
    },
    close: async () => {
      for (const socket of live) {
        socket.destroy()
      }
      live.clear()
      stalled.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** Re-points a pairing offer at `endpoint` without touching its keys or device token. */
export function repointPairingUrl(pairingUrl: string, endpoint: string): string {
  return encodePairingOffer({ ...decodePairingOffer(pairingUrl), endpoint })
}

export function readPairingEndpoint(pairingUrl: string): string {
  return decodePairingOffer(pairingUrl).endpoint
}
