import { describe, expect, it } from 'vitest'
import { getAgentRowPrimaryText } from './agent-row-primary-text'

describe('getAgentRowPrimaryText', () => {
  it('prefers orchestration display name over the raw hook prompt', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'You are working inside Orca, a multi-agent IDE.',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race',
          displayName: 'Fix checkout race'
        }
      })
    ).toBe('Fix checkout race')
  })

  it('falls back to task title when display name is absent', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'You are working inside Orca, a multi-agent IDE.',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race'
        }
      })
    ).toBe('Checkout race')
  })

  it('falls back to the raw prompt outside orchestration workers', () => {
    expect(getAgentRowPrimaryText({ prompt: 'Fix checkout race' })).toBe('Fix checkout race')
  })

  it('prefers an explicit custom label over orchestration display name and task title', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'You are working inside Orca, a multi-agent IDE.',
        customAgentLabel: 'Reset AI',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'ctx-1',
          taskTitle: 'Checkout race',
          displayName: 'Fix checkout race'
        }
      })
    ).toBe('Reset AI')
  })

  it('prefers a custom label over the raw prompt for non-orchestrated agents', () => {
    expect(
      getAgentRowPrimaryText({ prompt: 'Fix checkout race', customAgentLabel: 'Frontend' })
    ).toBe('Frontend')
  })

  it('falls through to auto-derived text when the label is empty or whitespace', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: 'Fix checkout race',
        customAgentLabel: '   ',
        orchestration: { taskId: 't', dispatchId: 'd', displayName: 'Fix checkout race' }
      })
    ).toBe('Fix checkout race')
  })
})
