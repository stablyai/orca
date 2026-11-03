import { describe, expect, it } from 'vitest'
import './own-retained-string'
import { createAgentStatusOscProcessor } from './agent-status-osc'

describe('OSC 9999 pending storage', () => {
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
        lastPayloadCleanOffset: 0,
        payloadCleanOffsets: [0]
      })
    }
  )
})
