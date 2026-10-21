import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import {
  AGENT_STATUS_RUNS_RUNTIME_CAPABILITY,
  deserializeAgentStatusCapabilities,
  hasAgentStatusRunCapability,
  serializeAgentStatusCapabilities
} from './agent-status-run-capability'

describe('agent status run capability codec', () => {
  it('round-trips the run-aware capability', () => {
    const encoded = serializeAgentStatusCapabilities(
      new Set([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY])
    )

    expect(deserializeAgentStatusCapabilities(encoded)).toEqual(
      new Set([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY])
    )
    expect(hasAgentStatusRunCapability(encoded)).toBe(true)
  })

  it('ignores unknown capabilities from newer peers', () => {
    expect(
      deserializeAgentStatusCapabilities([
        'agent-status.future.v2',
        AGENT_STATUS_RUNS_RUNTIME_CAPABILITY
      ])
    ).toEqual(new Set([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY]))
  })

  it('finds the run capability in the current host capability inventory', () => {
    expect(
      hasAgentStatusRunCapability([...RUNTIME_CAPABILITIES, AGENT_STATUS_RUNS_RUNTIME_CAPABILITY])
    ).toBe(true)
  })

  it.each([null, {}, 'agent-status.runs.v1', [null], ['']])(
    'rejects malformed capability envelope %#',
    (value) => {
      expect(deserializeAgentStatusCapabilities(value)).toBeNull()
      expect(hasAgentStatusRunCapability(value)).toBe(false)
    }
  )

  it('rejects an excessive capability envelope', () => {
    expect(
      deserializeAgentStatusCapabilities(
        Array.from({ length: 257 }, (_, index) => `agent-status.future-${index}`)
      )
    ).toBeNull()
  })

  it('defines the codec without advertising incomplete run-aware behavior', () => {
    expect(RUNTIME_CAPABILITIES).not.toContain(AGENT_STATUS_RUNS_RUNTIME_CAPABILITY)
  })
})
