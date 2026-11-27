import { describe, expect, it } from 'vitest'
import {
  describePluginTaskSessionOptions,
  sessionOptionsForAgent
} from './plugin-task-session-options'

const CLAUDE_PLAN = { agent: 'claude', model: 'claude-opus-5-5', effort: 'max' }

describe('plugin task session options', () => {
  it('applies options to the agent they name, without the agent key', () => {
    expect(sessionOptionsForAgent(CLAUDE_PLAN, 'claude')).toEqual({
      model: 'claude-opus-5-5',
      effort: 'max'
    })
    expect(describePluginTaskSessionOptions(CLAUDE_PLAN, 'claude')).toBe(
      'Starts with model claude-opus-5-5, effort max.'
    )
  })

  it('leaves other agents on their own defaults and says so', () => {
    expect(sessionOptionsForAgent(CLAUDE_PLAN, 'codex')).toBeUndefined()
    expect(describePluginTaskSessionOptions(CLAUDE_PLAN, 'codex')).toContain('are for claude')
  })

  it('applies unscoped options to any agent and nothing without an agent', () => {
    expect(sessionOptionsForAgent({ effort: 'high' }, 'codex')).toEqual({ effort: 'high' })
    expect(sessionOptionsForAgent({ effort: 'high' }, null)).toBeUndefined()
    expect(describePluginTaskSessionOptions(undefined, 'claude')).toBeNull()
  })
})
