import { once } from 'node:events'
import { createServer, connect, type Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from '../../src/shared/browser-network-tunnel-client'
import { BrowserNetworkTunnelSession } from '../../src/main/browser/browser-network-tunnel-session'
import { AndroidBrowserTunnelSocket } from './mobile-browser-tunnel-clients'

it('carries Android adapter bytes through the existing tunnel session to a real TCP destination', async () => {
  const peers = new Set<Socket>()
  const request: Buffer[] = []
  const destination = createServer({ allowHalfOpen: true }, (peer) => {
    peers.add(peer)
    peer.on('data', (bytes) => request.push(bytes))
    peer.on('end', () => peer.end(Buffer.from('response after client EOF')))
    peer.on('close', () => peers.delete(peer))
  })
  destination.listen(0, '127.0.0.1')
  await once(destination, 'listening')
  const address = destination.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing destination')
  }
  const output: Uint8Array[] = []
  let consumedEof = false
  let closed = false
  let retained = 0
  // Async delivery models the physical transport; authorization is outside this topology fixture.
  const host = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: (target) => connect({ host: target.host, port: target.port, allowHalfOpen: true }),
    sendBinary: (bytes) => {
      const frame = bytes.slice()
      queueMicrotask(() => client.handleBinary(frame))
      return true
    }
  })
  const client = new BrowserNetworkTunnelClient(
    {
      tunnelGeneration: 1,
      sendBinary: (bytes) => {
        const frame = bytes.slice()
        queueMicrotask(() => host.handleBinary(frame))
        return true
      },
      outboundMemory: {
        claimApplicationBytes: (count) => {
          retained += count
          return () => {
            retained -= count
          }
        }
      }
    },
    (callbacks) => new AndroidBrowserTunnelSocket(callbacks)
  )
  try {
    const socket = await client.open({ host: '127.0.0.1', port: address.port })
    socket.start(
      {
        read: async () => null,
        write: async (bytes) => {
          if (bytes) {
            output.push(bytes)
          } else {
            consumedEof = true
          }
        },
        close: () => {
          closed = true
        }
      },
      new TextEncoder().encode('request before client EOF')
    )
    await vi.waitFor(() => expect(consumedEof).toBe(true))
    expect(Buffer.concat(request).toString()).toBe('request before client EOF')
    expect(Buffer.concat(output).toString()).toBe('response after client EOF')
    expect(socket.readableEnded).toBe(true)
  } finally {
    client.close()
    host.close()
    for (const peer of peers) {
      peer.destroy()
    }
    await new Promise<void>((resolve) => destination.close(() => resolve()))
  }
  expect(closed).toBe(true)
  expect(retained).toBe(0)
})
