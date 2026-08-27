import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

function createRejectableDeferred<T>(): {
  promise: Promise<T>
  reject: (reason?: unknown) => void
} {
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, reject) => {
    rejectDeferred = reject
  })
  return { promise, reject: rejectDeferred }
}

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('does not dispatch a cwd title after an explicit agent working title if the shell owns the pane', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult('zsh')),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not validate a pending cwd title with an already in-flight inspection', async () => {
    const staleInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const freshInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(staleInspection.promise)
      .mockReturnValueOnce(freshInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    staleInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/orca-e2e-repo')

    freshInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/orca-e2e-repo')
  })

  it('does not validate a replaced pending title with an older pending-title inspection', async () => {
    const titleAInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const titleBInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(titleAInspection.promise)
      .mockReturnValueOnce(titleBInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-a')
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-b')
    titleAInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')

    titleBInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')
  })

  it('does not drop a replaced pending title from an older non-agent inspection', async () => {
    const titleAInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const titleBInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(titleAInspection.promise)
      .mockReturnValueOnce(titleBInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-a')
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-b')
    titleAInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')

    titleBInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('/tmp/title-b')
  })

  it('does not dispatch a pending cwd title when process inspection fails', async () => {
    const inspection = createRejectableDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    inspection.reject(new Error('inspection failed'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('prefers a later explicit completion title over a pending cwd title', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    coordinator.observeTitle('Codex done')
    inspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('Codex done')
  })

  it('still dispatches a generic completion title after process inspection confirms an agent', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult('codex')),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('Fix flaky e2e tests')
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('Fix flaky e2e tests')
  })

  it('keeps a generic title completion pending long enough for the first remote inspection', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'remote:terminal-1',
      getSettings: () => ({ activeRuntimeEnvironmentId: 'env-1' }),
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')
    vi.advanceTimersByTime(10_500)
    inspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('experimental-agent-observability')
  })
})
