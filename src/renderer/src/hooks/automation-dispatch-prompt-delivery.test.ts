import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult } from '../../../shared/automations-types'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ agentStatusByPaneKey: {} }),
    subscribe: vi.fn(() => () => {})
  }
}))

const markDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()
const releaseTerminalOwnership = vi.fn()
const finalizeTerminalOwnership = vi.fn(() => false)

async function createCompletion() {
  const { createAutomationDispatchCompletion } = await import('./automation-dispatch-completion')
  return createAutomationDispatchCompletion({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only run.id is read by the completion under test.
    run: { id: 'run-1' } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only worktree.id/displayName are read by the completion under test.
    worktree: { id: 'wt-1', displayName: 'Automation worktree' } as never,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership
  })
}

/**
 * A prompt that provably never reached the agent is a known failure, not a
 * lost contact: reporting dispatch_failed keeps a forever-idle agent from
 * posing as a live run (#21506).
 */
describe('automation dispatch completion on prompt-delivery failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markDispatchResult.mockResolvedValue(undefined)
    finalizeTerminalOwnership.mockReturnValue(false)
  })

  it('marks the run dispatch_failed instead of leaving it dispatched', async () => {
    const completion = await createCompletion()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handlePromptDeliveryFailed()
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        error: 'The automation prompt could not be delivered to the agent.'
      })
    )
    expect(releaseTerminalOwnership).toHaveBeenCalledOnce()
  })

  it('settles a delivery failure that arrived before the dispatch mark', async () => {
    const completion = await createCompletion()
    completion.handlePromptDeliveryFailed()

    await completion.settlePendingAfterDispatch()

    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('outranks a pending done that cannot reflect work the agent never received', async () => {
    const completion = await createCompletion()
    completion.handlePromptDeliveryFailed()
    completion.handleAgentDone()

    await completion.settlePendingAfterDispatch()

    expect(markDispatchResult).toHaveBeenCalledTimes(1)
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('ignores a delivery failure reported after the run already completed', async () => {
    const completion = await createCompletion()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handleAgentDone()
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())

    completion.handlePromptDeliveryFailed()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(markDispatchResult).toHaveBeenCalledTimes(1)
  })

  it('holds a done signal until delivery reports, then completes', async () => {
    const completion = await createCompletion()
    completion.expectPromptDelivery()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handleAgentDone()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handlePromptDeliverySucceeded()
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })

  it('lets a late delivery failure outrank a done held while delivery was pending', async () => {
    const completion = await createCompletion()
    completion.expectPromptDelivery()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handleAgentDone()
    completion.handlePromptDeliveryFailed()

    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('keeps a pre-dispatch done stashed through settle while delivery is pending', async () => {
    const completion = await createCompletion()
    completion.expectPromptDelivery()
    completion.handleAgentDone()

    await completion.settlePendingAfterDispatch()
    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handlePromptDeliveryFailed()
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('defers a clean exit while delivery is pending but not a proven failure', async () => {
    const completion = await createCompletion()
    completion.expectPromptDelivery()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handleExit(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handlePromptDeliveryFailed()
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('marks a proven non-zero exit immediately even while delivery is pending', async () => {
    const completion = await createCompletion()
    completion.expectPromptDelivery()
    await completion.settlePendingAfterDispatch()
    markDispatchResult.mockClear()

    completion.handleExit(1)

    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })
})
