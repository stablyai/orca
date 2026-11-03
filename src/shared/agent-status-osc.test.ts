import { describe, expect, it } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

describe('createAgentStatusOscProcessor', () => {
  it('uses the earliest mixed terminator and counts only parsed payload offsets', () => {
    const process = createAgentStatusOscProcessor()
    const result = process(
      '😀\x1b]9999;{"state":"working"}\x07A\x1b\\' +
        '\x1b]9999;{"state":"done"}\x1b\\B\x07' +
        '\x1b]9999;{malformed}\x07C'
    )

    expect(result).toEqual({
      cleanData: '😀A\x1b\\B\x07C',
      payloads: [
        { state: 'working', prompt: '' },
        { state: 'done', prompt: '' }
      ],
      lastPayloadCleanOffset: '😀A\x1b\\'.length,
      payloadCleanOffsets: ['😀'.length, '😀A\x1b\\'.length]
    })
  })

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

  it('applies the pending cap only to incomplete frames', () => {
    const marker = '\x1b]9999;{"state":"working"}'
    const atCap = marker + ' '.repeat(64 * 1024 - marker.length)
    const retained = createAgentStatusOscProcessor()
    expect(retained(`before${atCap}`).cleanData).toBe('before')
    expect(retained('\x1b')).toEqual({ cleanData: '', payloads: [], lastPayloadCleanOffset: null })
    expect(retained('\\after').cleanData).toBe('\\after')

    const exact = createAgentStatusOscProcessor()
    exact(atCap)
    expect(exact('\x07after')).toEqual({
      cleanData: 'after',
      payloads: [{ state: 'working', prompt: '' }],
      lastPayloadCleanOffset: 0,
      payloadCleanOffsets: [0]
    })

    const complete = createAgentStatusOscProcessor()
    expect(complete(`${atCap} \x1b\\after`)).toEqual({
      cleanData: 'after',
      payloads: [{ state: 'working', prompt: '' }],
      lastPayloadCleanOffset: 0,
      payloadCleanOffsets: [0]
    })
  })
})
