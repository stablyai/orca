import { describe, expect, it } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

describe('createAgentStatusOscProcessor', () => {
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
  })
})
