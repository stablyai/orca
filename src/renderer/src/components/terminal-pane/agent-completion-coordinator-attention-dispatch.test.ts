import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('does not dispatch completion when waiting states arrive mid-turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    // 'waiting' (e.g. a PermissionRequest) is mid-turn, not a completion.
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'Read',
      toolInput: '/repo/src/app.ts'
    })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'git status'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledTimes(2)
    expect(dispatchAttention).toHaveBeenLastCalledWith(
      'cursor',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'waiting',
          agentType: 'cursor',
          toolInput: 'git status'
        })
      })
    )
  })

  it('does not dispatch completion when a blocked state arrives mid-turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'copilot' as const
    }

    // 'blocked' (e.g. a Copilot elicitation dialog) is mid-turn, not a completion.
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'blocked',
      ...turn,
      toolName: 'Shell',
      toolInput: 'npm install'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledWith(
      'copilot',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'blocked',
          agentType: 'copilot',
          toolInput: 'npm install'
        })
      })
    )
  })

  it('cancels a pending done timer when a waiting state arrives before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // A permission/elicitation pause arrives before the 1.5s quiet window
    // expires; it must cancel the pending 'done' so no completion fires.
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'waiting',
          agentType: 'cursor',
          toolInput: 'pnpm test'
        })
      })
    )
  })

  it('still dispatches completion on done after an intervening waiting state in the same turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    // Realistic flow: the agent pauses for a permission prompt mid-turn, resumes,
    // then genuinely finishes. The intervening attention state must surface as
    // attention only and must not suppress the final completion. This fails if
    // 'waiting' is treated as a completion state (issue #5698).
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('dispatches a Codex attention notification immediately, like every other agent', () => {
    // Why: Codex used to debounce this behind a 1.5s window to hide auto-approved
    // pauses. The hook listener now classifies a reviewer-owned approval as
    // `working` at write time, so a Codex `waiting` that reaches here is a real
    // prompt and must notify at once (#21389).
    const dispatchAttention = vi.fn()
    const dispatchHookLifecycle = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      dispatchHookLifecycle,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'apply patch'
    })

    expect(dispatchHookLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'waiting', agentType: 'codex' })
    )
    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(dispatchAttention).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'waiting',
          agentType: 'codex',
          toolInput: 'apply patch'
        })
      })
    )
    // No Codex-only timer is armed any more.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('notifies the Codex pause and the completion that ends the same turn', () => {
    const dispatchAttention = vi.fn()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'waiting', ...turn, toolName: 'exec_command' })
    expect(dispatchAttention).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({ state: 'done', ...turn })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles foreground misses after Codex pauses before reporting a sustained exit', async () => {
    // Why: a real attention hook is positive liveness evidence even when the
    // local process table briefly misses the foreground agent during handoff.
    let foreground: string | null = 'codex'
    const dispatchAttention = vi.fn()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foreground)),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    foreground = null
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsyncTicks()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    const turn = { prompt: 'apply patch', agentType: 'codex' as const }
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'rm -rf build'
    })
    expect(dispatchAttention).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledExactlyOnceWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('notifies a Codex pause even when the pane stops being live right after it', () => {
    // Why: the removed quiet window re-checked isLive() when it expired, so a
    // genuine prompt on a pane that went non-live inside the window was dropped.
    const dispatchAttention = vi.fn()
    let live = true
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => live
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'waiting', ...turn, toolName: 'exec_command' })
    expect(dispatchAttention).toHaveBeenCalledTimes(1)

    live = false
    vi.advanceTimersByTime(5_000)

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
  })

  it('alerts once per wait while its re-statements keep one stateStartedAt', () => {
    // Why: the hook server re-publishes one Claude wait on sibling and child events, and the card
    // text moves to whichever prompt is still outstanding; only a new wait may alert again.
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'run both', agentType: 'claude' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn, stateStartedAt: 1_000 })
    for (const toolInput of ['lead cmd', 'lead cmd', 'child cmd']) {
      coordinator.observeHookStatus({
        state: 'waiting',
        ...turn,
        toolName: 'Bash',
        toolInput,
        stateStartedAt: 2_000
      })
    }
    expect(dispatchAttention).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({ state: 'working', ...turn, stateStartedAt: 3_000 })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Bash',
      toolInput: 'next cmd',
      stateStartedAt: 4_000
    })
    expect(dispatchAttention).toHaveBeenCalledTimes(2)
  })
})
