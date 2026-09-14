import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

describe('agent completion coordinator queued inspections', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('drops inspections queued by a disposed coordinator before starting live work', async () => {
    const blockers = Array.from({ length: 4 }, () =>
      createDeferred<RuntimeTerminalProcessInspection>()
    )
    const blockerInspectors = blockers.map((inspection) => vi.fn(() => inspection.promise))
    const blockerCoordinators = blockerInspectors.map((inspectProcess, index) =>
      createAgentCompletionCoordinator({
        paneKey: `tab-1:blocked-${index}`,
        getPtyId: () => `pty-blocked-${index}`,
        getSettings: () => null,
        inspectProcess,
        dispatchCompletion: vi.fn(),
        isLive: () => true
      })
    )

    blockerCoordinators.forEach((coordinator) => coordinator.startProcessTracking())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(
      blockerInspectors.every((inspectProcess) => inspectProcess.mock.calls.length === 1)
    ).toBe(true)

    const staleInspectProcesses = Array.from({ length: 8 }, () =>
      vi.fn(async () => processResult(null, false))
    )
    const staleCoordinators = staleInspectProcesses.map((inspectProcess, index) =>
      createAgentCompletionCoordinator({
        paneKey: `tab-1:stale-${index}`,
        getPtyId: () => `pty-stale-${index}`,
        getSettings: () => null,
        inspectProcess,
        dispatchCompletion: vi.fn(),
        isLive: () => true
      })
    )
    const liveInspectProcess = vi.fn(async () => processResult(null, false))
    const liveCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:live',
      getPtyId: () => 'pty-live',
      getSettings: () => null,
      inspectProcess: liveInspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true
    })

    for (const [index, coordinator] of staleCoordinators.entries()) {
      coordinator.observeTitle(`Codex working ${index}`)
      coordinator.observeTitle(`~/stale-${index}`)
    }
    liveCoordinator.observeTitle('Codex working')
    liveCoordinator.observeTitle('~/live')
    staleCoordinators.forEach((coordinator) => coordinator.dispose())

    blockers.forEach((inspection) => inspection.resolve(processResult(null, false)))
    await flushAsyncTicks()
    // Existing 100ms pump admits live work after blockers release.
    await vi.advanceTimersByTimeAsync(100)
    await flushAsyncTicks()

    expect(
      staleInspectProcesses.every((inspectProcess) => inspectProcess.mock.calls.length === 0)
    ).toBe(true)
    expect(liveInspectProcess).toHaveBeenCalledTimes(1)

    blockerCoordinators.forEach((coordinator) => coordinator.dispose())
    liveCoordinator.dispose()
  })
})
