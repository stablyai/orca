import { describe, expect, it } from 'vitest'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import { confirmAgentHibernationCandidates } from './agent-hibernation-confirmation'

function candidate(overrides: Partial<AgentHibernationCandidate> = {}): AgentHibernationCandidate {
  return {
    id: 'wt-bg|tab-1:leaf-1',
    worktreeId: 'wt-bg',
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    paneKeys: ['tab-1:leaf-1'],
    targetPtyIds: ['pty-1'],
    expectedRuntimePtyIds: ['pty-1'],
    signature: 'stable-signature',
    ...overrides
  }
}

describe('agent sleep confirmation', () => {
  it('requires two stable ticks and resets on signature changes', () => {
    const firstCandidate = candidate()
    const first = confirmAgentHibernationCandidates({}, [firstCandidate])
    expect(first.candidates).toEqual([])
    expect(
      confirmAgentHibernationCandidates(first.confirmationState, [firstCandidate]).candidates
    ).toEqual([firstCandidate])

    const changed = candidate({ signature: 'changed-signature' })
    expect(
      confirmAgentHibernationCandidates(first.confirmationState, [changed]).candidates
    ).toEqual([])
  })
})
