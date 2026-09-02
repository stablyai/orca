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
})
