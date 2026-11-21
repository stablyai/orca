import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it("confirms an exit whose prompt redraw lands inside a hidden pane's notice window", async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(3_000)

    // Main reports hidden output once per 5 s window; the agent exits and the prompt redraws inside it, unreported.
    coordinator.observeHiddenOutputActivity()
    await vi.advanceTimersByTimeAsync(4_000)
    foregroundProcess = null
    await vi.advanceTimersByTimeAsync(4_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // A second fresh read 3 s later confirms it.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('reads nothing and arms no timer for a quiet agent or shell, and once after an output burst', async () => {
    for (const foregroundProcess of ['codex', null]) {
      const inspectProcess = vi.fn(async () => processResult(foregroundProcess))
      const coordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        inspectProcess,
        dispatchCompletion: vi.fn(),
        isLive: () => true
      })

      coordinator.startProcessTracking()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(inspectProcess).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)

      // A burst shorter than the 750 ms throttle interval.
      for (let chunk = 0; chunk < 10; chunk += 1) {
        coordinator.observeOutputActivity()
        await vi.advanceTimersByTimeAsync(30)
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(inspectProcess).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
      coordinator.dispose()
    }
  })

  it('does not dispatch process-exit while an agent terminal still has child processes', async () => {
    let result = processResult('codex')
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    result = processResult('zsh', true)
    coordinator.observeOutputActivity()
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()

    result = processResult('zsh', false)
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_500)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it.each([
    {
      label: 'client-only uncertainty',
      result: {
        foregroundProcess: null,
        hasChildProcesses: false,
        verdict: 'unverifiable',
        reason: 'transport_loss'
      } satisfies RuntimeTerminalProcessInspection
    },
    {
      label: 'host child-process uncertainty',
      result: {
        foregroundProcess: '/bin/zsh',
        hasChildProcesses: false,
        childProcessEvidence: 'unverifiable'
      } satisfies RuntimeTerminalProcessInspection
    }
  ])('resets exit confirmation across $label', async ({ result: unavailableResult }) => {
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    result = processResult(null, false)
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(750)
    result = unavailableResult
    await vi.advanceTimersByTimeAsync(750)
    result = processResult(null, false)

    // Unavailable evidence resets the absence candidate; the next idle observation starts a fresh settle interval.
    await vi.advanceTimersByTimeAsync(1_500)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_250)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('suppresses replacement completion before coordinator state mutation', async () => {
    let foregroundProcess = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      shouldSuppressProcessReplacementCompletion: () => true,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = 'claude'
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeTitle('Claude done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('Claude done')
  })
})
