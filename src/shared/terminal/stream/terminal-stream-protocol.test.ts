import { describe, expect, it, vi } from 'vitest'
import {
  decodeTerminalStreamJson,
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
})
