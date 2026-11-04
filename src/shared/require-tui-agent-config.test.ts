import { describe, expect, it } from 'vitest'
import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import { requireTuiAgentConfig } from './require-tui-agent-config'

describe('requireTuiAgentConfig', () => {
  it('rejects a prototype key that Object.hasOwn keeps off the config', () => {
    expect(() => requireTuiAgentConfig('toString' as TuiAgent)).toThrow(/Unknown agent "toString"/)
  })
})
