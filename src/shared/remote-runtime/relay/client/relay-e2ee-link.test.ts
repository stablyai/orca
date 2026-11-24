import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from './node/node-relay-client-platform'
import type { RelayClientSocketEvents } from './relay-client-platform'
import { RelayE2eeLink } from './relay-e2ee-link'

function link(order: string[]) {
  let events!: RelayClientSocketEvents
  const instance = new RelayE2eeLink({
    platform: {
      ...NODE_RELAY_CLIENT_PLATFORM,
      createSocket: (_url, socketEvents) => {
        events = socketEvents
        return {
          OPEN: 1,
          readyState: 1,
          bufferedAmount: 0,
          send: () => order.push('sent'),
          close: () => order.push('socket closed')
        }
      }
    },
    endpoint: { cellUrl: 'https://cell.example', relayHostId: 'AbCdEf0123_-xyZ9' },
    credential: 'invite',
    expectedCredentialKind: 'invite',
    authCredential: { kind: 'token', deviceToken: 'token' },
    desktopPublicKeyB64: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),
    onOpen: () => order.push('open'),
    onAuthenticated: () => {},
    onText: () => {},
    onBinary: () => {},
    onError: () => order.push('error')
  })
  return { instance, events: () => events }
}

describe('RelayE2eeLink', () => {
  it('sends nothing and reports no open for a socket that opens after close()', () => {
    const order: string[] = []
    const { instance, events } = link(order)
    instance.close()
    events().onOpen()
    expect(order).toEqual(['socket closed'])
  })

  it('closes the socket before reporting a failure', async () => {
    const order: string[] = []
    const { events } = link(order)
    events().onMessage('not a relay hello')
    await vi.waitFor(() => expect(order).toContain('error'))
    expect(order).toEqual(['socket closed', 'error'])
  })
})
