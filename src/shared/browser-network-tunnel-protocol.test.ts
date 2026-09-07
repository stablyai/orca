import { describe, expect, it } from 'vitest'
import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelOpen,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate
} from './browser-network-tunnel-protocol'

describe('browser-network-tunnel-protocol', () => {
  it('round-trips remote DNS names without resolving them on the client', () => {
    const encoded = encodeBrowserNetworkTunnelFrame({
      opcode: BrowserNetworkTunnelOpcode.Open,
      tunnelGeneration: 7,
      streamId: 19,
      payload: encodeBrowserNetworkTunnelOpen({ host: 'service.internal.', port: 8443 })
    })

    const decoded = decodeBrowserNetworkTunnelFrame(encoded)

    expect(decoded).toMatchObject({
      opcode: BrowserNetworkTunnelOpcode.Open,
      tunnelGeneration: 7,
      streamId: 19
    })
    expect(decoded && decodeBrowserNetworkTunnelOpen(decoded.payload)).toEqual({
      host: 'service.internal.',
      port: 8443
    })
  })

  it('round-trips exact credit without accepting zero or overflow', () => {
    const payload = encodeBrowserNetworkTunnelWindowUpdate(256 * 1024)

    expect(decodeBrowserNetworkTunnelWindowUpdate(payload)).toBe(256 * 1024)
    expect(decodeBrowserNetworkTunnelWindowUpdate(new Uint8Array(4))).toBeNull()

    const overflow = payload.slice()
    new DataView(overflow.buffer).setUint32(0, 0xffffffff, false)
    expect(decodeBrowserNetworkTunnelWindowUpdate(overflow)).toBeNull()
  })

  it('rejects malformed, unknown, oversized, and length-mismatched frames', () => {
    const encoded = encodeBrowserNetworkTunnelFrame({
      opcode: BrowserNetworkTunnelOpcode.Data,
      tunnelGeneration: 1,
      streamId: 2,
      payload: new Uint8Array([1, 2, 3])
    })

    expect(decodeBrowserNetworkTunnelFrame(encoded.subarray(0, 15))).toBeNull()

    const badVersion = encoded.slice()
    badVersion[1] = 2
    expect(decodeBrowserNetworkTunnelFrame(badVersion)).toBeNull()

    const badOpcode = encoded.slice()
    badOpcode[2] = 255
    expect(decodeBrowserNetworkTunnelFrame(badOpcode)).toBeNull()

    const wrongLength = encoded.slice()
    new DataView(wrongLength.buffer).setUint32(12, 99, false)
    expect(decodeBrowserNetworkTunnelFrame(wrongLength)).toBeNull()

    expect(() =>
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Data,
        tunnelGeneration: 1,
        streamId: 2,
        payload: new Uint8Array(BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES + 1)
      })
    ).toThrow('payload')
  })

  it('rejects invalid open targets and payloads on control-only opcodes', () => {
    expect(() => encodeBrowserNetworkTunnelOpen({ host: '', port: 80 })).toThrow('host')
    expect(() => encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 0 })).toThrow('port')

    expect(() =>
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 1,
        streamId: 2,
        payload: new Uint8Array([1])
      })
    ).toThrow('empty')
  })

  it('rejects identities that cannot be represented as unsigned 32-bit values', () => {
    const payload = new Uint8Array()
    expect(() =>
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Ping,
        tunnelGeneration: 0x1_0000_0000,
        streamId: 0,
        payload
      })
    ).toThrow('generation')
    expect(() =>
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Data,
        tunnelGeneration: 1,
        streamId: 0x1_0000_0000,
        payload
      })
    ).toThrow('stream id')
  })
})
