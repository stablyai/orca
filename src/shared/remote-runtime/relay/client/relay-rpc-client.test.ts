import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from './node/node-relay-client-platform'
import type { RelayClientPlatform } from './relay-client-platform'
import { connectRelayRpcClient, type RelayRpcClientEvents } from './relay-rpc-client'

const hostKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64')

// A cell that never answers: the client never reaches an authenticated host.
function silentCell(order: string[]): RelayClientPlatform {
  return {
    ...NODE_RELAY_CLIENT_PLATFORM,
    createSocket: () => ({
      OPEN: 1,
      readyState: 0,
      bufferedAmount: 0,
      send: () => {},
      close: () => order.push('socket closed')
    })
  }
}

function connect(order: string[], events?: RelayRpcClientEvents) {
  return connectRelayRpcClient(
    {
      platform: silentCell(order),
      endpoint: { cellUrl: 'https://cell.example', relayHostId: 'AbCdEf0123_-xyZ9' },
      credential: 'invite',
      expectedCredentialKind: 'invite',
      authCredential: { kind: 'token', deviceToken: 'token' },
      desktopPublicKeyB64: hostKey,
      requestTimeoutMs: 1_000
    },
    events
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('connectRelayRpcClient', () => {
  it('times a request out within its budget while the host never authenticates', async () => {
    vi.useFakeTimers()
    const reply = connect([]).sendRequest('status.get')
    const settled = expect(reply).rejects.toThrow('relay RPC timed out: status.get')
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })

  it('refuses params it cannot serialize without leaving a pending request', async () => {
    vi.useFakeTimers()
    await expect(connect([]).sendRequest('status.get', { n: 1n })).rejects.toThrow(TypeError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles requests and closes the socket before a throwing close observer runs', async () => {
    const order: string[] = []
    const client = connect(order, {
      onClosed: () => {
        order.push('observer')
        throw new Error('observer failed')
      }
    })
    const reply = client.sendRequest('status.get').catch(() => order.push('request rejected'))
    expect(() => client.close()).not.toThrow()
    await reply
    expect(order).toEqual(['socket closed', 'observer', 'request rejected'])
  })
})
