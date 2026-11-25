import { describe, expect, it } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

describe('createAgentStatusOscProcessor', () => {
  it('preserves every split of prefixes, JSON, and both terminators across independent streams', () => {
    const stream =
      'before😀\x1b]9999;{"state":"working","prompt":"漢字"}\x07between' +
      '\x1b]9999;{"state":"done"}\x1b\\after'
    const expected = {
      cleanData: 'before😀betweenafter',
      payloads: [
        { state: 'working', prompt: '漢字' },
        { state: 'done', prompt: '' }
      ],
      lastPayloadCleanOffset: 'before😀between'.length
    }
    const other = createAgentStatusOscProcessor()

    for (let split = 0; split <= stream.length; split += 1) {
      const process = createAgentStatusOscProcessor()
      const first = process(stream.slice(0, split))
      expect(other('\x1b]9999;{"state":"blocked"}\x07').payloads).toEqual([
        { state: 'blocked', prompt: '' }
      ])
      const second = process(stream.slice(split))

      expect(first.cleanData + second.cleanData, `split ${split}`).toBe(expected.cleanData)
      expect([...first.payloads, ...second.payloads], `split ${split}`).toEqual(expected.payloads)
      const lastOffset =
        second.lastPayloadCleanOffset === null
          ? first.lastPayloadCleanOffset
          : first.cleanData.length + second.lastPayloadCleanOffset
      expect(lastOffset, `split ${split}`).toBe(expected.lastPayloadCleanOffset)
    }
  })
})
