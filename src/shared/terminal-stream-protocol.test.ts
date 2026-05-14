import { describe, expect, it } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from './terminal-stream-protocol'

describe('terminal-stream-protocol', () => {
  it('round-trips fixed-width binary frame headers and payloads', () => {
    const payload = encodeTerminalStreamText('hello terminal')
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: 42,
      seq: 9,
      payload
    })

    const decoded = decodeTerminalStreamFrame(encoded)

    expect(decoded?.opcode).toBe(TerminalStreamOpcode.Output)
    expect(decoded?.streamId).toBe(42)
    expect(decoded?.seq).toBe(9)
    expect(decoded ? decodeTerminalStreamText(decoded.payload) : '').toBe('hello terminal')
  })

  it('round-trips snapshot metadata JSON payloads', () => {
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.SnapshotStart,
      streamId: 7,
      seq: 1,
      payload: encodeTerminalStreamJson({ kind: 'scrollback', cols: 49, rows: 28 })
    })

    const decoded = decodeTerminalStreamFrame(encoded)

    expect(decoded && decodeTerminalStreamJson(decoded.payload)).toEqual({
      kind: 'scrollback',
      cols: 49,
      rows: 28
    })
  })

  it('rejects unknown frame versions and opcodes', () => {
    const encoded = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: 1,
      seq: 1,
      payload: new Uint8Array()
    })

    const badVersion = encoded.slice()
    badVersion[1] = 99
    expect(decodeTerminalStreamFrame(badVersion)).toBeNull()

    const badOpcode = encoded.slice()
    badOpcode[2] = 99
    expect(decodeTerminalStreamFrame(badOpcode)).toBeNull()
  })
})
