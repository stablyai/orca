import { describe, expect, it } from 'vitest'
import './protocol-version'
import {
  AGENT_STATUS_RUNS_RUNTIME_CAPABILITY,
  deserializeAgentStatusCapabilities
} from './agent-status-run-capability'

describe('agent status run capability codec', () => {
  it('ignores unknown capabilities from newer peers', () => {
    expect(
      deserializeAgentStatusCapabilities([
        'agent-status.future.v2',
        AGENT_STATUS_RUNS_RUNTIME_CAPABILITY
      ])
    ).toEqual(new Set([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY]))
  })
})
