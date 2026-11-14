import { describe, expect, it } from 'vitest'
import * as mainProtocol from '../../../main/ssh/protocol/remote-frame-protocol'
import { HEADER_LENGTH, MAX_MESSAGE_SIZE } from '../../../shared/relay-frame-decoder'
import {
  encodeJsonRpcFrame,
  encodePreparedJsonRpcFrame,
  prepareJsonRpcPayload,
  type JsonRpcNotification
} from './protocol'

describe('prepared relay JSON payload framing', () => {
  it('accepts the exact payload maximum and rejects one byte more', () => {
    const base: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'x',
      params: { data: '' }
    }
    const overhead = Buffer.byteLength(JSON.stringify(base))
    const exact = { ...base, params: { data: 'a'.repeat(MAX_MESSAGE_SIZE - overhead) } }
    const oversized = { ...base, params: { data: 'a'.repeat(MAX_MESSAGE_SIZE - overhead + 1) } }

    const relayPrepared = prepareJsonRpcPayload(exact)
    const mainPrepared = mainProtocol.prepareJsonRpcPayload(exact)
    expect(relayPrepared.byteLength).toBe(MAX_MESSAGE_SIZE)
    expect(mainPrepared.byteLength).toBe(MAX_MESSAGE_SIZE)
    expect(encodePreparedJsonRpcFrame(relayPrepared, 1, 0)).toHaveLength(
      HEADER_LENGTH + MAX_MESSAGE_SIZE
    )
    expect(() => prepareJsonRpcPayload(oversized)).toThrow('Message too large')
    expect(() => mainProtocol.prepareJsonRpcPayload(oversized)).toThrow('Message too large')
    expect(() => encodeJsonRpcFrame(oversized, 1, 0)).toThrow('Message too large')
    expect(() => mainProtocol.encodeJsonRpcFrame(oversized, 1, 0)).toThrow('Message too large')
  })
})
