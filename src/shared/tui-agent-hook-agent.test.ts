import { describe, expect, it } from 'vitest'
import { isAgentHookSource } from './agent-hook-relay'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { getTuiAgentHookAgent } from './tui-agent-hook-agent'

describe('getTuiAgentHookAgent', () => {
  it('names claude for the launches that run Claude Code hooks', () => {
    expect(getTuiAgentHookAgent('claude-agent-teams')).toBe('claude')
    expect(getTuiAgentHookAgent('openclaude')).toBe('claude')
  })

  it('names every launch that has its own hook route after itself', () => {
    const own = Object.keys(TUI_AGENT_CONFIG).filter(isAgentHookSource)
    expect(own.length).toBeGreaterThan(20)
    for (const agent of own) {
      expect(getTuiAgentHookAgent(agent)).toBe(agent)
    }
  })
})
