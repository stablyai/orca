import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  encodeBrowserNetworkTunnelFrame
} from './browser-network-tunnel-protocol'
import {
  decodeRelayNetworkTunnelFrame,
  encodeRelayNetworkTunnelFrame,
  parseRelayNetworkTunnelHandle,
  parseRelayNetworkTunnelOwner,
  readRelayNetworkTunnelIncarnation,
  RELAY_NETWORK_TUNNEL_CAPABILITY,
  RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES
} from './relay-network-tunnel-contract'

const owner = {
  version: 1 as const,
  runtimeIncarnation: 'runtime',
  ownerGeneration: 2,
  ownerLease: 'lease'
}

it.each([
  undefined,
  {},
  { capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY] },
  { capabilities: [], networkTunnel: { version: 1, runtimeIncarnation: 'runtime' } },
  {
    capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY],
    networkTunnel: { version: 2, runtimeIncarnation: 'runtime' }
  },
  {
    capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY],
    networkTunnel: { version: 1, runtimeIncarnation: '' }
  }
])('refuses missing or incompatible relay tunnel negotiation: %j', (status) => {
  expect(() => readRelayNetworkTunnelIncarnation(status)).toThrow('capability_unavailable')
})

it('accepts negotiated incarnation while ignoring future optional status fields', () => {
  expect(
    readRelayNetworkTunnelIncarnation({
      capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY, 'future'],
      networkTunnel: { version: 1, runtimeIncarnation: 'runtime', future: true }
    })
  ).toBe('runtime')
})
const handle = { ...owner, tunnelGeneration: 3 }
const data = (length = 1, tunnelGeneration = 3) =>
  encodeBrowserNetworkTunnelFrame({
    opcode: BrowserNetworkTunnelOpcode.Data,
    tunnelGeneration,
    streamId: 1,
    payload: new Uint8Array(length).fill(255)
  })

describe('relay network tunnel identity', () => {
  it('copies and freezes validated fields while tolerating unknown additions', () => {
    const parsedOwner = parseRelayNetworkTunnelOwner({ ...handle, future: true })
    const parsedHandle = parseRelayNetworkTunnelHandle({ ...handle, future: true })
    expect(parsedOwner).toEqual(owner)
    expect(parsedHandle).toEqual(handle)
    expect(Object.isFrozen(parsedOwner)).toBe(true)
    expect(Object.isFrozen(parsedHandle)).toBe(true)
    expect(parsedHandle).not.toBe(handle)
  })

  it.each([null, undefined, [], 'owner', 1, {}, { ...owner, version: 2 }])(
    'rejects malformed owner %j',
    (value) => {
      expect(() => parseRelayNetworkTunnelOwner(value)).toThrow('invalid_owner')
    }
  )

  it.each([
    { runtimeIncarnation: '' },
    { runtimeIncarnation: 'r'.repeat(129) },
    { runtimeIncarnation: 1 },
    { ownerLease: '' },
    { ownerLease: 'l'.repeat(1025) },
    { ownerLease: false },
    { ownerGeneration: 0 },
    { ownerGeneration: -1 },
    { ownerGeneration: 1.5 },
    { ownerGeneration: '2' },
    { ownerGeneration: Number.NaN },
    { ownerGeneration: Infinity },
    { ownerGeneration: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects invalid owner bounds %j', (fields) => {
    expect(() => parseRelayNetworkTunnelOwner({ ...owner, ...fields })).toThrow('invalid_owner')
  })

  it('accepts exact identity bounds', () => {
    expect(
      parseRelayNetworkTunnelHandle({
        version: 1,
        runtimeIncarnation: 'r'.repeat(128),
        ownerLease: 'l'.repeat(1024),
        ownerGeneration: Number.MAX_SAFE_INTEGER,
        tunnelGeneration: 0xffff_ffff
      }).tunnelGeneration
    ).toBe(0xffff_ffff)
    expect(parseRelayNetworkTunnelHandle({ ...handle, tunnelGeneration: 1 }).tunnelGeneration).toBe(
      1
    )
  })

  it.each([undefined, 0, -1, 1.5, '3', Number.NaN, Infinity, 0x1_0000_0000])(
    'rejects generation %j',
    (tunnelGeneration) => {
      expect(() => parseRelayNetworkTunnelHandle({ ...owner, tunnelGeneration })).toThrow(
        'invalid_generation'
      )
    }
  )
})

describe('relay network tunnel frame envelope', () => {
  it('round trips maximum existing data frames with extra envelope fields', () => {
    const bytes = data(64 * 1024)
    expect(bytes.byteLength).toBe(RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES)
    const envelope = encodeRelayNetworkTunnelFrame(handle, bytes)
    expect(Object.isFrozen(envelope)).toBe(true)
    const decoded = decodeRelayNetworkTunnelFrame({ ...envelope, future: 'ignored' })
    expect(decoded.handle).toEqual(handle)
    expect(Object.isFrozen(decoded.handle)).toBe(true)
    expect(Buffer.from(decoded.bytes)).toEqual(Buffer.from(bytes))
  })

  it('encodes only the provided view and copies its contents', () => {
    const bytes = data()
    const backing = new Uint8Array(bytes.length + 10)
    backing.set(bytes, 5)
    const envelope = encodeRelayNetworkTunnelFrame(handle, backing.subarray(5, 5 + bytes.length))
    backing.fill(0)
    expect(Buffer.from(decodeRelayNetworkTunnelFrame(envelope).bytes)).toEqual(Buffer.from(bytes))
  })

  it.each(['', ' ', '====', 'AA', 'AA=', 'A===', 'AA==\n', 'AA-_', 'AB=='])(
    'rejects noncanonical base64 %j',
    (frame) => {
      expect(() => decodeRelayNetworkTunnelFrame({ ...handle, frame })).toThrow('invalid_frame')
    }
  )

  it('rejects noncanonical padding bits on an otherwise valid frame', () => {
    const envelope = encodeRelayNetworkTunnelFrame(handle, data())
    const changed = `${envelope.frame.slice(0, -2)}/=`
    expect(Buffer.from(changed, 'base64')).toEqual(Buffer.from(envelope.frame, 'base64'))
    expect(() => decodeRelayNetworkTunnelFrame({ ...envelope, frame: changed })).toThrow(
      'invalid_frame'
    )
  })

  it('rejects oversized encoded input before allocating a decoded buffer', () => {
    const spy = vi.spyOn(Buffer, 'from')
    try {
      expect(() =>
        decodeRelayNetworkTunnelFrame({
          ...handle,
          frame: 'A'.repeat(Math.ceil(RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES / 3) * 4 + 1)
        })
      ).toThrow('invalid_frame')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects oversized decoded frames even within the base64 length ceiling', () => {
    const bytes = Buffer.alloc(RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES + 1)
    expect(() => encodeRelayNetworkTunnelFrame(handle, bytes)).toThrow('invalid_frame')
    expect(() =>
      decodeRelayNetworkTunnelFrame({ ...handle, frame: bytes.toString('base64') })
    ).toThrow('invalid_frame')
  })

  it.each([null, undefined, 1, {}])('rejects non-string frame %j', (frame) => {
    expect(() => decodeRelayNetworkTunnelFrame({ ...handle, frame })).toThrow('invalid_frame')
  })

  it('rejects invalid inner framing and stale inner generation on both paths', () => {
    const malformed = data()
    malformed[2] = 255
    for (const bytes of [new Uint8Array(0), new Uint8Array(16), malformed, data(1, 4)]) {
      expect(() => encodeRelayNetworkTunnelFrame(handle, bytes)).toThrow('invalid_frame')
      expect(() =>
        decodeRelayNetworkTunnelFrame({ ...handle, frame: Buffer.from(bytes).toString('base64') })
      ).toThrow('invalid_frame')
    }
  })
})
