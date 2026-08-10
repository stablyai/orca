import { describe, expect, it } from 'vitest'
import type { AgentMapStatusCounts } from './agent-map-layout'
import { agentMapWorktreeActiveStatus } from './agent-map-worktree-active-status'

function counts(overrides: Partial<AgentMapStatusCounts> = {}): AgentMapStatusCounts {
  return { blocked: 0, waiting: 0, working: 0, done: 0, idle: 0, ...overrides }
}

describe('agentMapWorktreeActiveStatus', () => {
  it('prioritizes attention over working', () => {
    expect(agentMapWorktreeActiveStatus(counts({ working: 2, waiting: 1 }))).toBe('waiting')
    expect(agentMapWorktreeActiveStatus(counts({ working: 2, waiting: 1, blocked: 1 }))).toBe(
      'blocked'
    )
  })

  it('uses working only when no agent needs attention', () => {
    expect(agentMapWorktreeActiveStatus(counts({ working: 1, done: 2 }))).toBe('working')
    expect(agentMapWorktreeActiveStatus(counts({ done: 2, idle: 1 }))).toBeNull()
  })
})
