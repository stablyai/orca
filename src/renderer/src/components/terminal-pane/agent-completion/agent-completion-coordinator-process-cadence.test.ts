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

  it('still detects an unannounced process exit while hidden, at the slower cadence', async () => {
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

    // Agent exits with no completion title/hook — only the poll can notice.
    foregroundProcess = null
    // First idle sample requires a repeat before announcing (no dispatch yet).
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Second idle sample confirms the exit ~2 hidden polls (~6s) after it happened.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
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
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeTitle('Claude done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('Claude done')
  })
})
