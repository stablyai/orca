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

  it('cancels a hook completion when the same turn resumes work before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS - 1)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: true,
        agentStatus: expect.objectContaining({
          state: 'done',
          prompt: 'run the goal',
          agentType: 'codex'
        })
      })
    )
  })

  it('cancels a hook completion when title tracking observes resumed work before quiet', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    coordinator.observeTitleWorking()
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it.each([
    'claude',
    'codex',
    'gemini',
    'opencode',
    'cursor',
    'droid',
    'grok',
    'devin',
    'copilot',
    'hermes'
  ])('recognizes %s hook agent ids even when the binary name differs', (agentType) => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType
    })

    expect(dispatchCompletion).toHaveBeenCalledWith(agentType)
  })

  it.each(['pi', 'omp'])(
    'defers a %s milestone done without prior working through the quiet window',
    (agentType) => {
      const dispatchCompletion = vi.fn()
      const coordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })

      // Pi/OMP emit agent_end ('done') between milestones with no prior 'working';
      // the done must wait out the quiet window instead of firing immediately.
      coordinator.observeHookStatus({
        state: 'done',
        prompt: 'run the mission',
        agentType
      })
      expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS - 1)
      expect(dispatchCompletion).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
      expect(dispatchCompletion).toHaveBeenCalledWith(
        agentType,
        expect.objectContaining({ source: 'hook', quietedHookDone: true })
      )
    }
  )

  it('suppresses a Pi milestone done when work resumes before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // Pi resumes (a tool_call mapped to 'working') before the window elapses,
    // which must cancel the premature "finished".
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still dispatches a Codex done-without-prior-working immediately', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    // Codex only emits 'done' at turn end, so it must keep its immediate dispatch.
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'fix the bug',
      agentType: 'codex'
    })

    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('still fires a pending Pi done when process inspection sees the agent exit first', async () => {
    // Why: a process-exit probe landing inside the quiet window must not tear
    // down agent evidence, or the pending hook 'done' would be silently dropped.
    let foregroundProcess: string | null = 'pi'
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

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // The agent process disappears mid-window; the cadence poll must not drop
    // the pending completion.
    foregroundProcess = null
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'pi',
      expect.objectContaining({ source: 'hook' })
    )
  })

  it('notifies once after a Cursor tool-heavy turn, not on each shell hook', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'working',
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
      state: 'working',
      ...turn,
      toolName: 'Shell',
      toolInput: 'git status'
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Fixed.' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })
})
