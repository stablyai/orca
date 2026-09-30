import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

// The renderer opts a read into the cheap tier ONLY when it is a self-correcting cadence poll on a
// local pane. Pending-title reads decide a completion once and remote reads consume evidence, so
// neither may ask for a capture that omits evidence.
describe('agent completion steadyState opt-in', () => {
  useAgentCompletionCoordinatorLifecycle()

  const optionsOf = (call: unknown[]): unknown => call[2]

  it('marks cadence polls on a local pane as steadyState', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    vi.advanceTimersByTime(3_000)
    await flushAsyncTicks()
    expect(inspectProcess).toHaveBeenCalled()
    for (const call of inspectProcess.mock.calls) {
      expect(optionsOf(call as unknown[])).toEqual({ steadyState: true })
    }
    coordinator.dispose()
  })

  it('a pending-title read on a local pane is NOT steadyState: it decides a completion once', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })
    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    await flushAsyncTicks()
    expect(inspectProcess).toHaveBeenCalled()
    for (const call of inspectProcess.mock.calls) {
      expect(optionsOf(call as unknown[])).toBeUndefined()
    }
    coordinator.dispose()
  })

  it('never marks a remote pane as steadyState: remote identity needs evidence', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'remote:pty-1',
      isRemotePtyId: () => true,
      getExpectedIncarnationId: () => 'inc-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    vi.advanceTimersByTime(3_000)
    await flushAsyncTicks()
    expect(inspectProcess).toHaveBeenCalled()
    for (const call of inspectProcess.mock.calls) {
      expect(optionsOf(call as unknown[])).toEqual({ expectedIncarnationId: 'inc-1' })
    }
    coordinator.dispose()
  })
})
