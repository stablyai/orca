import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  ambiguousLocalProcessResult,
  createDeferred,
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

describe('agent completion coordinator queued inspections', () => {
  useAgentCompletionCoordinatorLifecycle()

  it.each(['command', 'binding', 'owner', 'incarnation', 'disposed'] as const)(
    'rejects observations superseded by a new %s during either read',
    async (change) => {
      for (const phase of ['inspection', 'confirmation']) {
        const read = createDeferred<RuntimeTerminalProcessInspection>()
        const confirmation = createDeferred<string | null>()
        const getPtyId = vi.fn(() => 'pty-1')
        const getObservationOwner = vi.fn(() => 'codex')
        const getExpectedIncarnationId = vi.fn(() => 'inc-1')
        const onForegroundShellObserved = vi.fn()
        const inspectProcess = vi.fn(() => read.promise)
        const confirmForegroundProcess = vi.fn(() => confirmation.promise)
        const coordinator = createAgentCompletionCoordinator({
          paneKey: 'tab-1:leaf-1',
          getPtyId,
          getObservationOwner,
          getExpectedIncarnationId,
          inspectProcess,
          confirmForegroundProcess,
          dispatchCompletion: vi.fn(),
          onForegroundShellObserved,
          isLive: () => true
        })
        coordinator.observeForegroundAgentProcess({ agent: 'codex', processName: 'codex' })
        coordinator.startProcessTracking()
        await vi.advanceTimersByTimeAsync(1_000)
        if (phase === 'confirmation') {
          read.resolve(ambiguousLocalProcessResult())
          await flushAsyncTicks()
          await vi.advanceTimersByTimeAsync(3_000)
          expect(inspectProcess).toHaveBeenCalledTimes(1)
          expect(confirmForegroundProcess).toHaveBeenCalledTimes(1)
        }
        const supersede = {
          command: coordinator.invalidateProcessInspection,
          binding: () => getPtyId.mockReturnValue('replacement'),
          owner: () => getObservationOwner.mockReturnValue('claude'),
          incarnation: () => getExpectedIncarnationId.mockReturnValue('inc-2'),
          disposed: coordinator.dispose
        }
        supersede[change]()
        read.resolve(processResult('zsh', false))
        confirmation.resolve('zsh')
        await flushAsyncTicks()
        expect(onForegroundShellObserved).not.toHaveBeenCalled()
        coordinator.dispose()
      }
    }
  )

  it('drops inspections queued by a disposed coordinator before starting live work', async () => {
    const blockers = Array.from({ length: 4 }, () =>
      createDeferred<RuntimeTerminalProcessInspection>()
    )
    const blockerInspectors = blockers.map((inspection) => vi.fn(() => inspection.promise))
    const blockerCoordinators = blockerInspectors.map((inspectProcess, index) =>
      createAgentCompletionCoordinator({
        paneKey: `tab-1:blocked-${index}`,
        getPtyId: () => `pty-blocked-${index}`,
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
        inspectProcess,
        dispatchCompletion: vi.fn(),
        isLive: () => true
      })
    )
    const liveInspectProcess = vi.fn(async () => processResult(null, false))
    const liveCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:live',
      getPtyId: () => 'pty-live',
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
