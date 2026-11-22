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
    await vi.advanceTimersByTimeAsync(4_000)

    // Main reports hidden output once per 5 s window; the agent exits and the prompt redraws inside it, unreported.
    coordinator.observeHiddenOutputActivity()
    await vi.advanceTimersByTimeAsync(4_000)
    foregroundProcess = null
    await vi.advanceTimersByTimeAsync(4_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // The read after the notice window sees it gone, and the next fresh read confirms it.
    await vi.advanceTimersByTimeAsync(4_500)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('reads nothing and arms no timer for a quiet agent or shell, and once after an output burst', async () => {
    for (const foregroundProcess of ['codex', null]) {
      // The host reports this agent's exit as an event, so nothing needs re-checking at rest.
      const inspectProcess = vi.fn(async (): Promise<RuntimeTerminalProcessInspection> => ({
        foregroundProcess,
        hasChildProcesses: foregroundProcess !== null,
        ...(foregroundProcess ? { foregroundExitWatched: true as const } : {})
      }))
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

  it('keeps a slow re-check for an idle agent whose host cannot report its exit', async () => {
    let result = processResult('codex')
    const dispatchCompletion = vi.fn()
    const inspectProcess = vi.fn(async () => result)
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // An older host or one that could not watch the pid: the agent exits silently and nothing prints.
    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('keeps a slow re-check when the pane cannot receive the host exit notice', async () => {
    let result: RuntimeTerminalProcessInspection = {
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      foregroundExitWatched: true
    }
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true,
      receivesForegroundExitNotices: () => false
    })
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('reads again when a shared capture predates the output that asked for the read', async () => {
    const observed = (capturedAgeMs: number): RuntimeTerminalProcessInspection => ({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      foregroundProcessEvidence: {
        verdict: 'unverifiable',
        reason: 'test',
        authorityGeneration: 'host',
        observationEpoch: 1,
        capturedAgeMs,
        ptyId: 'pty-1',
        ptyIncarnationId: 'inc-1'
      }
    })
    const inspectProcess = vi
      .fn(async () => observed(0))
      .mockImplementationOnce(async () => observed(10_000))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true
    })
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(inspectProcess).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })

  it('confirms an exit once a background child outlives the redraw and then ends silently', async () => {
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
    await vi.advanceTimersByTimeAsync(3_000)

    result = processResult('zsh', true)
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })

  it('keeps reading while a cached agent name contradicts the host child census', async () => {
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

    // The agent exits; the prompt redraw's read still names it from a cache.
    result = {
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    }
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    result = {
      foregroundProcess: 'pwsh.exe',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    coordinator.dispose()
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
    await vi.advanceTimersByTimeAsync(3_000)

    result = processResult('zsh', true)
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(1_250)

    expect(dispatchCompletion).not.toHaveBeenCalled()

    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(1_250)

    expect(dispatchCompletion).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_250)

    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_500)
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
    await vi.advanceTimersByTimeAsync(3_000)
    result = processResult(null, false)
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(1_250)
    result = unavailableResult
    await vi.advanceTimersByTimeAsync(1_250)
    result = processResult(null, false)

    // Unavailable evidence resets the absence candidate; the next idle observation starts a fresh settle interval.
    await vi.advanceTimersByTimeAsync(2_500)
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
