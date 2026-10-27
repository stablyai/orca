import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  TERMINAL_STREAM_JSON_STRUCTURE_LIMITS
} from './terminal-stream-protocol'

describe('terminal-stream-protocol', () => {
  it('rejects excessive JSON nesting before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      const depth = TERMINAL_STREAM_JSON_STRUCTURE_LIMITS.nestingDepth + 1
      const payload = new TextEncoder().encode(`${'['.repeat(depth)}0${']'.repeat(depth)}`)

      expect(decodeTerminalStreamJson(payload)).toBeNull()
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
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
