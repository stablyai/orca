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

  it('uses the task block when orchestration metadata has not arrived yet', () => {
    expect(
      getAgentRowPrimaryText({
        prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: term_parent
Your task ID is: task_1

=== CLI COMMANDS ===
orca orchestration send --to term_parent

=== TASK ===
Review dispatch prompts and make worker labels distinct

Keep the raw preamble out of the sidebar.`
      })
    ).toBe('Review dispatch prompts and make worker labels distinct')
  })

  it('falls back to the raw prompt outside orchestration workers', () => {
    expect(getAgentRowPrimaryText({ prompt: 'Fix checkout race' })).toBe('Fix checkout race')
  })
})
