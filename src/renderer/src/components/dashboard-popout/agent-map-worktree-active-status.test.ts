import { describe, expect, it } from 'vitest'
import { emptyAgentMapStatusCounts, type AgentMapStatusCounts } from './agent-map-node-metadata'
import { agentMapWorktreeActiveStatus } from './agent-map-worktree-active-status'

function counts(overrides: Partial<AgentMapStatusCounts> = {}): AgentMapStatusCounts {
  return { ...emptyAgentMapStatusCounts(), ...overrides }
}

describe('agentMapWorktreeActiveStatus', () => {
  it('turns the ring green only once the whole workspace has settled', () => {
    expect(agentMapWorktreeActiveStatus(counts({ done: 1 }))).toBe('done')
    // Anything still running outranks a finished sibling — the workspace is still working.
    expect(agentMapWorktreeActiveStatus(counts({ done: 1, working: 1 }))).toBe('working')
    expect(agentMapWorktreeActiveStatus(counts({ done: 1, waiting: 1 }))).toBe('waiting')
    expect(agentMapWorktreeActiveStatus(counts({ done: 1, blocked: 1 }))).toBe('blocked')
  })

  it('leaves the ring unlit for acknowledged finishes and idle workspaces', () => {
    // Acknowledging is what releases the attention, exactly as at the node level.
    expect(agentMapWorktreeActiveStatus(counts({ 'done-seen': 3 }))).toBeNull()
    expect(agentMapWorktreeActiveStatus(counts({ idle: 2 }))).toBeNull()
    expect(agentMapWorktreeActiveStatus(counts())).toBeNull()
  })

  it('prioritizes attention over working', () => {
    expect(agentMapWorktreeActiveStatus(counts({ working: 2, waiting: 1 }))).toBe('waiting')
    expect(agentMapWorktreeActiveStatus(counts({ working: 2, waiting: 1, blocked: 1 }))).toBe(
      'blocked'
    )
  })

  it('uses working only when no agent needs attention', () => {
    expect(agentMapWorktreeActiveStatus(counts({ working: 1, done: 2 }))).toBe('working')
    // Was null before unread finishes lit the ring; idle siblings do not mute a finish.
    expect(agentMapWorktreeActiveStatus(counts({ done: 2, idle: 1 }))).toBe('done')
    expect(agentMapWorktreeActiveStatus(counts({ 'done-seen': 2, idle: 1 }))).toBeNull()
  })

  it('keeps passive monitoring out of the active-worktree glow', () => {
    expect(agentMapWorktreeActiveStatus(counts({ monitoring: 1 }))).toBeNull()
    expect(agentMapWorktreeActiveStatus(counts({ working: 1, monitoring: 1 }))).toBe('working')
  })
})
