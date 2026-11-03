import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult } from '../../../shared/automations-types'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ agentStatusByPaneKey: {} }),
    subscribe: vi.fn(() => () => {})
  }
}))

const markDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()
const releaseTerminalOwnership = vi.fn()
const finalizeTerminalOwnership = vi.fn<AutomationTerminalOwnership['finalize']>(async () => null)

async function createCompletion() {
  const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
  return createAutomationDispatchCompletion({
    run: { id: 'run-1' } as never,
    worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership,
    agentLabel: 'Pi'
  })
}

// Why: an interrupted terminal turn used to be recorded as a completed run (STA-12638).
describe('automation dispatch completion for an interrupted turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markDispatchResult.mockResolvedValue(undefined)
  })

  it.each([
    { name: 'after the dispatch is marked', doneFirst: false },
    { name: 'before the dispatch is marked', doneFirst: true }
  ])('records it as failed and keeps the terminal, $name', async ({ doneFirst }) => {
    const completion = await createCompletion()
    if (doneFirst) {
      completion.handleAgentDone({ interrupted: true })
      await completion.settlePendingAfterDispatch()
    } else {
      await completion.settlePendingAfterDispatch()
      completion.handleAgentDone({ interrupted: true })
    }
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalled())

    expect(markDispatchResult).toHaveBeenCalledTimes(1)
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: 'Pi was Interrupted. Open the terminal or run the automation again.'
      })
    )
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('still records an uninterrupted turn as completed', async () => {
    const completion = await createCompletion()
    await completion.settlePendingAfterDispatch()
    completion.handleAgentDone({})
    await vi.waitFor(() => expect(finalizeTerminalOwnership).toHaveBeenCalled())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', error: null })
    )
  })
})
