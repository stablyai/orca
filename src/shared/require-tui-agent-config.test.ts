import { describe, expect, it } from 'vitest'
import type { TuiAgent } from './tui-agent'
import { requireTuiAgentConfig } from './require-tui-agent-config'

describe('requireTuiAgentConfig', () => {
  it('returns the config for a known agent', () => {
    expect(requireTuiAgentConfig('codex').preflightTrust).toBe('codex')
  })

  it('names the unknown id instead of throwing a property-of-undefined error', () => {
    // A custom-agent id persisted by a branch build, read back by one without the feature.
    const stale = 'custom-agent:codex:b2e1ff6f-8932-413a-9133-edffa44e0ee9' as TuiAgent
    expect(() => requireTuiAgentConfig(stale)).toThrow(
      `Unknown agent "${stale}". This version of Orca has no such agent — pick a different agent and try again.`
    )
  })

  it('rejects a prototype key that Object.hasOwn keeps off the config', () => {
    expect(() => requireTuiAgentConfig('toString' as TuiAgent)).toThrow(/Unknown agent "toString"/)
  })
})
