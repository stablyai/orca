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

  it('round-trips terminal input and resize frames', () => {
    const input = decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        streamId: 11,
        seq: 1,
        payload: encodeTerminalStreamText('a')
      })
    )
    const resize = decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Resize,
        streamId: 11,
        seq: 2,
        payload: encodeTerminalStreamJson({ cols: 120, rows: 40 })
      })
    )

    expect(input?.opcode).toBe(TerminalStreamOpcode.Input)
    expect(input ? decodeTerminalStreamText(input.payload) : '').toBe('a')
    expect(resize?.opcode).toBe(TerminalStreamOpcode.Resize)
    expect(resize && decodeTerminalStreamJson(resize.payload)).toEqual({ cols: 120, rows: 40 })
  })

  it('round-trips multiplex subscribe and unsubscribe frames', () => {
    const subscribe = decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 12,
          terminal: 'terminal-1',
          viewport: { cols: 120, rows: 40 }
        })
      })
    )
    const unsubscribe = decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Unsubscribe,
        streamId: 12,
        seq: 2,
        payload: new Uint8Array()
      })
    )

    expect(subscribe?.opcode).toBe(TerminalStreamOpcode.Subscribe)
    expect(subscribe && decodeTerminalStreamJson(subscribe.payload)).toMatchObject({
      streamId: 12,
      terminal: 'terminal-1'
    })
    expect(unsubscribe?.opcode).toBe(TerminalStreamOpcode.Unsubscribe)
    expect(unsubscribe?.streamId).toBe(12)
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
