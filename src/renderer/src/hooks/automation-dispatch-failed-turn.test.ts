import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationDispatchResult } from '../../../shared/automations-types'

const PANE_KEY = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'
const store = vi.hoisted((): { agentStatusByPaneKey: Record<string, AgentStatusEntry> } => ({
  agentStatusByPaneKey: {}
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store,
    subscribe: vi.fn(() => () => {})
  }
}))

const markDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()

// A failed turn is still a finished turn: the run must settle rather than wait forever on a
// `done` it already saw. The failure is shown on the row, not recorded on the run.
describe('automation dispatch completion on a failed turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markDispatchResult.mockResolvedValue(undefined)
  })

  it('completes the run when the agent turn ends in the provider error', async () => {
    const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
    const completion = createAutomationDispatchCompletion({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion reads only the run id.
      run: { id: 'run-1' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion reads only the worktree id and name.
      worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
      precheckResult: null,
      markDispatchResult,
      releaseTerminalOwnership: vi.fn(),
      finalizeTerminalOwnership: vi.fn(() => false)
    })
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    store.agentStatusByPaneKey = {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        state: 'done',
        prompt: 'run the job',
        updatedAt: 2_000,
        stateStartedAt: 2_000,
        stateHistory: [],
        lastAssistantMessage: 'API Error: 400',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 2_000 }
      }
    }
    completion.observeAgentStatus(PANE_KEY, 1_000)

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', status: 'completed' })
      )
    )
  })
})
