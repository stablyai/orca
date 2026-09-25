import { WebSocketServer, type WebSocket } from 'ws'
import { CloudRelayTransport } from '../../src/main/runtime/rpc/relay-transport'

/** Local byte-splice topology from mobile-relay-e2ee.integration.test; not a production cell. */
export async function browserRelaySplice(relayHostId: string, deviceId: string) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve) => relay.once('listening', resolve))
  const address = relay.address()
  if (!address || typeof address === 'string') {
    throw new Error('No relay address')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const transport = new CloudRelayTransport({ cellUrl: origin, relayHostId, generation: 1 })
  const phones = new Map<string, WebSocket>()
  let sequence = 0
  relay.on('connection', (socket, request) => {
    socket.once('message', () => {
      if (request.url?.startsWith('/v1/connect/')) {
        const id = `browser-${++sequence}`
        phones.set(id, socket)
        void transport.openConnection({
          connId: id,
          connTicket: 'A'.repeat(43),
          kind: 'resume',
          relayDeviceId: deviceId,
          attachDeadlineMs: 5_000
        })
        return
      }
      const id = request.url?.split('/').at(-1) ?? ''
      const phone = phones.get(id)
      if (!phone) {
        throw new Error('Unknown relay phone')
      }
      socket.on('message', (bytes, binary) => {
        if (phone.readyState === phone.OPEN) {
          phone.send(bytes, { binary })
        }
      })
      phone.on('message', (bytes, binary) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(bytes, { binary })
        }
      })
      socket.once('close', () => phone.close())
      phone.once('close', () => socket.close())
      phone.send(
        JSON.stringify({
          type: 'relay-hello',
          ok: true,
          credentialKind: 'resume',
          acceptedCredentialVersion: 1,
          acceptedAs: 'current',
          leaseExpiresAt: Date.now() + 60_000,
          resumeExpiresAt: Date.now() + 300_000
        })
      )
    })
  })
  await transport.start()
  return {
    transport,
    origin,
    connectionCount: () => sequence,
    close: async () => {
      await transport.stop()
      for (const client of relay.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => relay.close(() => resolve()))
    }
  }
}
