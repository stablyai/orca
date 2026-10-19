import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { idleEdgeSettledAtRest, isClaudeIdleEdge } from './agent-idle-edge'

const row = (agentType: string): AgentStatusEntry => ({
  state: 'done',
  prompt: '',
  updatedAt: 1,
  stateStartedAt: 1,
  paneKey: 'tab:leaf',
  stateHistory: [],
  agentType
})

describe('agent idle edges', () => {
  it('recognizes Claude from its status row once its title drops the ✳ glyph', () => {
    expect(isClaudeIdleEdge('✳ Fix the parser', undefined)).toBe(true)
    expect(isClaudeIdleEdge('Fix the parser', row('claude'))).toBe(true)
    expect(isClaudeIdleEdge('Fix the parser', row('codex'))).toBe(false)
  })

  it("trusts the tracker's classification and reads the title only without one", () => {
    expect(idleEdgeSettledAtRest('Fix the parser', { status: 'idle' })).toBe(true)
    expect(idleEdgeSettledAtRest('✳ Claude Code', { status: 'permission' })).toBe(false)
    expect(idleEdgeSettledAtRest('✳ Claude Code', undefined)).toBe(true)
  })
})
