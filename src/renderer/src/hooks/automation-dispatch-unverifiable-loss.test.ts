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
  const completion = createAutomationDispatchCompletion({
    run: { id: 'run-1' } as never,
    worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership
  })
  await completion.settlePendingAfterDispatch()
  markDispatchResult.mockClear()
  return completion
}

/**
 * Loss of contact is never evidence of process death
 * (docs/reference/ssh-execution-boundary.md). The exit sentinel these readers
 * receive is the same one the terminal panes already classify as unverifiable.
 */
describe('automation dispatch completion on an unverifiable loss', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markDispatchResult.mockResolvedValue(undefined)
    finalizeTerminalOwnership.mockResolvedValue(null)
  })

  it('records no result, so the run keeps its non-final dispatched status', async () => {
    // Exit -1 is unobserved relay/host loss, never a witnessed finish; SSH work may still run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).not.toHaveBeenCalled()
    // Closing a terminal whose process cannot be proven dead orphans live work.
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('still completes and finalizes a genuinely exited process', async () => {
    const completion = await createCompletion()
    finalizeTerminalOwnership.mockResolvedValue('closed')

    completion.handleExit(0)
    await vi.waitFor(() => expect(finalizeTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', status: 'completed', error: null })
    )
    expect(releaseTerminalOwnership).not.toHaveBeenCalled()
  })

  it('still reports a real automation failure as dispatch_failed', async () => {
    const completion = await createCompletion()

    completion.handleExit(9)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        error: 'Automation process exited with code 9.'
      })
    )
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
  })

  it('lets a later done still complete a run whose contact was lost', async () => {
    // Loss withholds judgment; later positive evidence must still finish the run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completion = await createCompletion()

    completion.handleExit(-1)
    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())
    completion.handleAgentDone()

    await vi.waitFor(() =>
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      )
    )
    warnSpy.mockRestore()
  })
})
