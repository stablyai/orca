import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('does not schedule cadence process inspections for hidden idle panes', () => {
    const inspectProcess = vi.fn(async () => processResult(null))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(10_000)

    expect(inspectProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the process-exit backstop after hidden panes gain agent evidence', async () => {
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

    coordinator.startProcessTracking()
    expect(vi.getTimerCount()).toBe(0)

    coordinator.observeTitle('Codex working')
    // Why: hidden panes poll the backstop at the throttled 3s cadence, not the
    // 2s idle / 750ms active cadence reserved for visible panes.
    vi.advanceTimersByTime(3_000)
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(1)
  })

  // Why: regression guard for the hidden-pane throttle (follow-up to #6288 /
  // PR #6667). A hidden pane with a live agent kept polling the OS process
  // table at full 750ms cadence purely as a backstop, wasting idle CPU on
  // shared SSH relays. It now polls at the 3s hidden cadence. Pre-fix this
  // counted ~78 inspections over 60s; post-fix ~20. The assertion fails on the
  // pre-fix code (>25) and passes after, so it locks in the reduction.
  it('throttles a hidden agent pane to the 3s backstop cadence over a 60s window', async () => {
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

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(60_000)

    const hiddenCalls = inspectProcess.mock.calls.length
    // ~60_000 / 3_000 = 20 (jitter pinned to 1.0 via the Math.random spy).
    expect(hiddenCalls).toBeGreaterThanOrEqual(15)
    expect(hiddenCalls).toBeLessThanOrEqual(25)
  })

  it('keeps a visible agent pane at full 750ms cadence over a 60s window', async () => {
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
    await vi.advanceTimersByTimeAsync(60_000)

    // ~60_000 / 750 ≈ 78; the hidden throttle must not regress visible panes.
    expect(inspectProcess.mock.calls.length).toBeGreaterThanOrEqual(70)
  })

  it('re-arms full cadence immediately when a throttled hidden pane becomes visible', async () => {
    let visible = false
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => visible
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    // First hidden poll runs and arms the next 3s backstop timer.
    await vi.advanceTimersByTimeAsync(3_000)
    const callsBeforeFlip = inspectProcess.mock.calls.length
    expect(callsBeforeFlip).toBeGreaterThanOrEqual(1)

    // 600ms into the 3s hidden interval: no new inspection yet.
    await vi.advanceTimersByTimeAsync(600)
    expect(inspectProcess.mock.calls.length).toBe(callsBeforeFlip)

    // Becoming visible (lifecycle calls startProcessTracking) must drop the slow
    // pending timer and re-arm at full cadence rather than wait out the ~2.4s left.
    visible = true
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(900)

    expect(inspectProcess.mock.calls.length).toBeGreaterThan(callsBeforeFlip)
  })

  it('still detects an unannounced process exit while hidden, at the slower cadence', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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

  it('clears process evidence after agent exit so later non-agent spinner titles do not notify', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('⠋ codex')
    coordinator.observeTitle('codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    foregroundProcess = 'zsh'
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    dispatchCompletion.mockClear()
    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not dispatch process-exit while an agent terminal still has child processes', async () => {
    let result = processResult('codex')
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('keeps hook working evidence across unavailable inspections', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => ({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true as const
      })),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeHookStatus({ state: 'working', agentType: 'codex', prompt: 'test' })
    await vi.advanceTimersByTimeAsync(2_000)
    coordinator.observeHookStatus({ state: 'done', agentType: 'codex', prompt: 'test' })

    expect(dispatchCompletion).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit-title evidence across unavailable inspections', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => ({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true as const
      })),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)
    coordinator.observeClassifiedTitleCompletion('done')

    expect(dispatchCompletion).toHaveBeenCalledExactlyOnceWith('done')
  })

  it('resets exit confirmation across an unavailable inspection', async () => {
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    result = processResult(null, false)
    await vi.advanceTimersByTimeAsync(750)
    result = { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
    await vi.advanceTimersByTimeAsync(750)
    result = processResult(null, false)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not mark an agent-to-agent process replacement as terminal idle', async () => {
    let foregroundProcess = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = 'claude'
    await vi.advanceTimersByTimeAsync(750)

    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false
    })
  })

  it('suppresses replacement completion before coordinator state mutation', async () => {
    let foregroundProcess = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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

  it('suppresses confirmed process exit when the owner vetoes the exited process', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const shouldSuppressConfirmedProcessExitCompletion = vi.fn(() => true)
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      shouldSuppressConfirmedProcessExitCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = null
    await vi.advanceTimersByTimeAsync(1_500)

    expect(shouldSuppressConfirmedProcessExitCompletion).toHaveBeenCalledWith({
      agent: 'codex',
      processName: 'codex'
    })
    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('suppresses process-exit backstop after a title completion already notified the turn', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('⠋ codex')
    coordinator.observeTitle('codex done')
    foregroundProcess = null
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex done')
  })
})
