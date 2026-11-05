import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'
import {
  createDeferred,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion local exit confirmation', () => {
  useAgentCompletionCoordinatorLifecycle()

  async function trackAgent(
    confirmForegroundProcess = vi.fn(async (): Promise<string | null> => 'codex'),
    agent = 'codex'
  ) {
    let result = processResult(agent)
    const dispatchCompletion = vi.fn()
    const onForegroundAgentExited = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => result),
      confirmForegroundProcess,
      dispatchCompletion,
      onForegroundAgentExited,
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    return {
      coordinator,
      dispatchCompletion,
      onForegroundAgentExited,
      confirmForegroundProcess,
      setInspection: (foreground: string | null, children: boolean) => {
        result = processResult(foreground, children)
      }
    }
  }

  it('preserves terminal modes when a fresh read cannot establish the foreground', async () => {
    const tracked = await trackAgent(vi.fn(async () => null))
    tracked.setInspection('pwsh.exe', false)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(tracked.confirmForegroundProcess).toHaveBeenCalled()
    expect(tracked.onForegroundAgentExited).not.toHaveBeenCalled()
    expect(tracked.dispatchCompletion).not.toHaveBeenCalled()
    tracked.coordinator.dispose()
  })

  it('does not mistake an ordinary foreground child for a return to the shell', async () => {
    const tracked = await trackAgent(vi.fn(async () => 'rg.exe'))
    tracked.setInspection('pwsh.exe', false)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(tracked.confirmForegroundProcess).toHaveBeenCalled()
    expect(tracked.onForegroundAgentExited).not.toHaveBeenCalled()
    tracked.coordinator.dispose()
  })

  it('detects exit when cached and fresh reads report the same unlisted shell name', async () => {
    const tracked = await trackAgent(vi.fn(async () => '-zsh'))
    tracked.setInspection('-zsh', false)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(tracked.onForegroundAgentExited).toHaveBeenCalledExactlyOnceWith({
      agent: 'codex',
      processName: 'codex'
    })
    tracked.coordinator.dispose()
  })

  it('discards a fresh shell result after its coordinator has been disposed', async () => {
    const pending = createDeferred<string | null>()
    const tracked = await trackAgent(vi.fn(() => pending.promise))
    tracked.setInspection('pwsh.exe', false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(tracked.confirmForegroundProcess).toHaveBeenCalled()

    tracked.coordinator.dispose()
    pending.resolve('pwsh.exe')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tracked.onForegroundAgentExited).not.toHaveBeenCalled()
    expect(tracked.dispatchCompletion).not.toHaveBeenCalled()
  })

  it.each(['pwsh.exe', 'codex'])(
    "discards a replaced agent's late %s confirmation without delaying the replacement's exit",
    async (lateForeground) => {
      const pending = createDeferred<string | null>()
      const tracked = await trackAgent(
        vi
          .fn(async (): Promise<string | null> => 'pwsh.exe')
          .mockImplementationOnce(() => pending.promise)
      )
      tracked.setInspection('pwsh.exe', false)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(tracked.confirmForegroundProcess).toHaveBeenCalledTimes(1)

      tracked.coordinator.observeForegroundAgentProcess({ agent: 'claude', processName: 'claude' })
      tracked.dispatchCompletion.mockClear()
      pending.resolve(lateForeground)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(POLL_TIER_INTERVAL_MS.active * 3)

      expect(tracked.onForegroundAgentExited).not.toHaveBeenCalled()
      expect(tracked.dispatchCompletion).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(POLL_TIER_INTERVAL_MS.active)
      expect(tracked.onForegroundAgentExited).toHaveBeenCalledExactlyOnceWith({
        agent: 'claude',
        processName: 'claude'
      })
      tracked.coordinator.dispose()
    }
  )
})
