import { describe, expect, it } from 'vitest'
import {
  agentSupportsModelSelection,
  applyAgentModelToArgs,
  getAgentModelInfo
} from './tui-agent-models'

describe('tui-agent-models', () => {
  it('exposes model info only for agents with a known flag', () => {
    expect(getAgentModelInfo('claude')?.flag).toBe('--model')
    expect(agentSupportsModelSelection('claude')).toBe(true)
    expect(getAgentModelInfo('cline')).toBeNull()
    expect(agentSupportsModelSelection('cline')).toBe(false)
  })

  it('appends the model flag for a supported agent', () => {
    expect(applyAgentModelToArgs('claude', '--verbose', 'opus')).toBe('--verbose --model opus')
    expect(applyAgentModelToArgs('claude', '', 'sonnet')).toBe('--model sonnet')
  })

  it('ignores a blank model', () => {
    expect(applyAgentModelToArgs('claude', '--verbose', '')).toBe('--verbose')
    expect(applyAgentModelToArgs('claude', '--verbose', null)).toBe('--verbose')
    expect(applyAgentModelToArgs('claude', '--verbose', '   ')).toBe('--verbose')
  })

  it('does not inject for an agent without a known flag', () => {
    expect(applyAgentModelToArgs('cline', '--verbose', 'whatever')).toBe('--verbose')
  })

  it('does not duplicate a model flag the user already set in args', () => {
    expect(applyAgentModelToArgs('claude', '--model haiku', 'opus')).toBe('--model haiku')
    expect(applyAgentModelToArgs('claude', '--model=haiku', 'opus')).toBe('--model=haiku')
  })
})
