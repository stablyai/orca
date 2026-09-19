import { describe, expect, it, vi } from 'vitest'
import * as ownership from './own-retained-string'
import { createAgentStatusOscProcessor } from './agent-status-osc'

const INCOMPLETE_STATUS = '\x1b]9999;{"state":"working","prompt":"fragment'

describe('OSC 9999 pending storage', () => {
  it('routes every retained pending frame through ownRetainedString', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const process = createAgentStatusOscProcessor()
      expect(process('x'.repeat(32 * 1024) + INCOMPLETE_STATUS).cleanData).toHaveLength(32 * 1024)
      expect(own).toHaveBeenCalledTimes(1)
      expect(own).toHaveBeenLastCalledWith(INCOMPLETE_STATUS)

      // Ownership is unconditional: a growing frame is re-owned on every chunk.
      for (let index = 0; index < 8; index += 1) {
        process('x'.repeat(512))
      }
      expect(own).toHaveBeenCalledTimes(9)
      expect(own).toHaveBeenLastCalledWith(INCOMPLETE_STATUS + 'x'.repeat(8 * 512))
    } finally {
      own.mockRestore()
    }
  })

  it.each([
    [16 * 1024, 256],
    [64 * 1024, 64],
    [1024 * 1024, 16]
  ])('keeps %i-character chunks with %i incomplete statuses byte-exact', (size, count) => {
    const parsers: ReturnType<typeof createAgentStatusOscProcessor>[] = []
    let cleanChars = 0

    for (let index = 0; index < count; index += 1) {
      const process = createAgentStatusOscProcessor()
      cleanChars += process(String.fromCharCode(65 + (index % 26)).repeat(size) + INCOMPLETE_STATUS)
        .cleanData.length
      parsers.push(process)
    }

    expect(cleanChars).toBe(size * count)
    for (const process of parsers) {
      expect(process('"}\x07after')).toEqual({
        cleanData: 'after',
        payloads: [{ state: 'working', prompt: 'fragment' }],
        lastPayloadCleanOffset: 0
      })
    }
  })

  it.each(['\x07', '\x1b\\'])(
    'preserves raw UTF-16 across an owned suffix and %j',
    (terminator) => {
      const process = createAgentStatusOscProcessor()
      const ordinary = '😀'.repeat(8 * 1024)
      const promptStart = '漢字\ud800|\udc00|\ud83d'

      expect(process(`${ordinary}\x1b]9999;{"state":"working","prompt":"${promptStart}`)).toEqual({
        cleanData: ordinary,
        payloads: [],
        lastPayloadCleanOffset: null
      })
      expect(process(`\ude00"}${terminator}after`)).toEqual({
        cleanData: 'after',
        payloads: [{ state: 'working', prompt: '漢字\ud800|\udc00|😀' }],
        lastPayloadCleanOffset: 0
      })
    }
  )

  it('drops an owned frame that grows past the pending cap', () => {
    const process = createAgentStatusOscProcessor()
    const marker = '\x1b]9999;{"state":"working"}'
    const pending = marker + ' '.repeat(64 * 1024 - marker.length)
    for (let offset = 0; offset < pending.length; offset += 512) {
      process(pending.slice(offset, offset + 512))
    }

    expect(process('\x07after')).toEqual({
      cleanData: 'after',
      payloads: [{ state: 'working', prompt: '' }],
      lastPayloadCleanOffset: 0
    })
  })
})
