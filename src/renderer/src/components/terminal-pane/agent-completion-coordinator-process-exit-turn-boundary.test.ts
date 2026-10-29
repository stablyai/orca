import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator process-exit turn boundary', () => {
  useAgentCompletionCoordinatorLifecycle()

  const paneKey = 'tab-1:leaf-1'

  // The pane's own lane confirms an agent process exit and notifies for it.
  async function notifyProcessExit(): Promise<{
    ptyLane: ReturnType<typeof createAgentCompletionCoordinator>
    showForeground: (process: string) => void
  }> {
    const ptyDispatch = vi.fn()
    let result = processResult('opencode')
    const ptyLane = createAgentCompletionCoordinator({
      paneKey,
      statusLane: 'pty',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion: ptyDispatch,
      isLive: () => true
    })
    ptyLane.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()
    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushAsyncTicks()
    expect(ptyDispatch).toHaveBeenCalledTimes(1)
    return {
      ptyLane,
      showForeground: (process) => {
        result = processResult(process)
      }
    }
  }

  function createHookLane(dispatchCompletion: () => void) {
    return createAgentCompletionCoordinator({
      paneKey,
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => processResult(null)),
      dispatchCompletion,
      isLive: () => true
    })
  }

  it('still treats a hook Done with no new turn as the exited process completion', async () => {
    const { ptyLane } = await notifyProcessExit()
    const hookDispatch = vi.fn()
    const hookLane = createHookLane(hookDispatch)
    hookLane.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'opencode',
      stateStartedAt: 1_700_000_000_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(hookDispatch).not.toHaveBeenCalled()
    ptyLane.dispose()
    hookLane.dispose()
  })

  it('notifies later hook turns after an unreported process exit in the same pane', async () => {
    // Status turned off for the exited agent (or an idle client quit), so no hook reported it.
    const { ptyLane, showForeground } = await notifyProcessExit()

    // A later agent in the same pane reports its turns through hooks only.
    showForeground('opencode')
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()
    const hookDispatch = vi.fn()
    const hookLane = createHookLane(hookDispatch)
    for (const turnStartedAt of [1_700_000_000_000, 1_700_000_100_000]) {
      hookLane.observeHookStatus({
        state: 'working',
        prompt: 'Reply with the single word pong.',
        agentType: 'opencode',
        stateStartedAt: turnStartedAt
      })
      hookLane.observeHookStatus({
        state: 'done',
        prompt: 'Reply with the single word pong.',
        agentType: 'opencode',
        stateStartedAt: turnStartedAt + 20_000
      })
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    }

    expect(hookDispatch).toHaveBeenCalledTimes(2)
    ptyLane.dispose()
    hookLane.dispose()
  })
})
