import { describe, expect, it } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

describe('createAgentStatusOscProcessor', () => {
  it('keeps ordinary chunks on the clean-data identity path', () => {
    const process = createAgentStatusOscProcessor()
    const data = 'plain terminal output\r\nwith ANSI-like text [0m\n'

    const result = process(data)

    expect(result.cleanData).toBe(data)
    expect(result.payloads).toEqual([])
    expect(result.lastPayloadCleanOffset).toBeNull()
  })

  it('strips OSC 9999 payloads from terminal data and returns parsed statuses', () => {
    const process = createAgentStatusOscProcessor()

    const result = process(
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after'
    )

    expect(result.cleanData).toBe('beforeafter')
    expect(result.payloads).toEqual([
      {
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      }
    ])
    expect(result.lastPayloadCleanOffset).toBe('before'.length)
  })

  it('preserves parser state across split OSC 9999 chunks', () => {
    const process = createAgentStatusOscProcessor()

    expect(process('before\x1b]999').cleanData).toBe('before')
    const result = process('9;{"state":"done","prompt":"ok"}\x1b\\after')

    expect(result.cleanData).toBe('after')
    expect(result.payloads).toEqual([
      {
        state: 'done',
        prompt: 'ok'
      }
    ])
    expect(result.lastPayloadCleanOffset).toBe(0)
  })

  it('retains a marker prefix split across chunks without leaking it as output', () => {
    const process = createAgentStatusOscProcessor()

    const first = 'before\x1b]99'
    expect(process(first)).toMatchObject({
      cleanData: 'before',
      payloads: [],
      lastPayloadCleanOffset: null
    })

    const result = process('99;{"state":"working","prompt":"split"}\x07after')

    expect(result.cleanData).toBe('after')
    expect(result.payloads).toEqual([{ state: 'working', prompt: 'split' }])
    expect(result.lastPayloadCleanOffset).toBe(0)
  })

  it('retains an unterminated OSC 9999 payload until its terminator arrives', () => {
    const process = createAgentStatusOscProcessor()

    expect(process('before\x1b]9999;{"state":"working","prompt":"par')).toMatchObject({
      cleanData: 'before',
      payloads: [],
      lastPayloadCleanOffset: null
    })

    const result = process('tial"}\x1b\\after')

    expect(result.cleanData).toBe('after')
    expect(result.payloads).toEqual([{ state: 'working', prompt: 'partial' }])
    expect(result.lastPayloadCleanOffset).toBe(0)
  })

  it('does not treat malformed or unrelated control data as an OSC status marker', () => {
    const process = createAgentStatusOscProcessor()
    const data = '\x1b[31mwarning\x07\x1b]999x\n'

    const result = process(data)

    expect(result.cleanData).toBe(data)
    expect(result.payloads).toEqual([])
    expect(result.lastPayloadCleanOffset).toBeNull()
  })

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
      lastPayloadCleanOffset: '😀A\x1b\\'.length
    })
  })

  it('preserves every split of prefixes, JSON, and both terminators across independent streams', () => {
    const stream =
      'before😀\x1b]9999;{"state":"working","prompt":"漢字"}\x07between' +
      '\x1b]9999;{"state":"done"}\x1b\\after'
    const expected = createAgentStatusOscProcessor()(stream)
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

  it('keeps a distant ST usable after many intervening BEL frames', () => {
    const count = 200
    const bel = Array.from(
      { length: count },
      (_, index) => `\x1b]9999;{"state":"working","prompt":"${index}"}\x07`
    ).join('')
    const result = createAgentStatusOscProcessor()(
      `${bel}\x1b]9999;{"state":"done","prompt":"last"}\x1b\\tail`
    )

    expect(result.payloads).toEqual([
      ...Array.from({ length: count }, (_, index) => ({
        state: 'working',
        prompt: String(index)
      })),
      { state: 'done', prompt: 'last' }
    ])
    expect(result.cleanData).toBe('tail')
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
      lastPayloadCleanOffset: 0
    })

    const complete = createAgentStatusOscProcessor()
    expect(complete(`${atCap} \x1b\\after`)).toEqual({
      cleanData: 'after',
      payloads: [{ state: 'working', prompt: '' }],
      lastPayloadCleanOffset: 0
    })
  })
})
