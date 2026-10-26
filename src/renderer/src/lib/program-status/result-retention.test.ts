import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { dismissRetainedProgramResult } from './result-retention'

const PANE = 'tab-1:leaf-1'

function programDone(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    agentType: 'brew',
    paneKey: PANE,
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    programStatus: { state: 'done', observedAt: 1_000 },
    ...overrides
  }
}

describe('program status result retention', () => {
  const dropAgentStatus = vi.fn()
  beforeEach(() => {
    dropAgentStatus.mockClear()
  })

  const dismiss = (entry: AgentStatusEntry | undefined): void =>
    dismissRetainedProgramResult(PANE, { agentStatusByPaneKey: { [PANE]: entry }, dropAgentStatus })

  it('dismisses a finished program result whenever the pane sees input', () => {
    dismiss(programDone())
    dismiss(programDone({ programStatus: { state: 'error', observedAt: 1_000 } }))
    expect(dropAgentStatus).toHaveBeenCalledTimes(2)
  })

  it('leaves agents, live programs, boundaries and empty panes alone', () => {
    dismiss(programDone({ agentType: 'claude' }))
    dismiss(programDone({ state: 'working', programStatus: { state: 'working', observedAt: 1 } }))
    dismiss(programDone({ sessionBoundary: true }))
    dismiss(undefined)
    expect(dropAgentStatus).not.toHaveBeenCalled()
  })
})
