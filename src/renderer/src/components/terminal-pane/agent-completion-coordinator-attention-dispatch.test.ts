import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

const CODEX_ATTENTION_QUIET_MS = 1_500

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

  it('suppresses the attention dispatch when shouldSuppressHookCompletion matches', () => {
    // Why: guards the merge seam where the suppressor must short-circuit before
    // the attention path, so auto-approved Codex pauses never notify.
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true,
      shouldSuppressHookCompletion: (payload) =>
        payload.state === 'waiting' || payload.state === 'blocked'
    })

    const turn = {
      prompt: 'implement notifications',
      agentType: 'codex' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'git status'
    })
    coordinator.observeHookStatus({
      state: 'blocked',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'rm file'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchAttention).not.toHaveBeenCalled()
    expect(dispatchCompletion).not.toHaveBeenCalled()
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

  it('cancels a pending done timer when a suppressed attention state arrives before the quiet window', () => {
    // Why: a suppressed Codex auto-approval pause must still cancel a provisional
    // 'done' so the quiet-window timer never fires a false completion notification.
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true,
      shouldSuppressHookCompletion: (payload) =>
        payload.state === 'waiting' || payload.state === 'blocked'
    })

    const turn = {
      prompt: 'implement notifications',
      agentType: 'codex' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'git status'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).not.toHaveBeenCalled()
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

  it('cancels the debounced Codex attention notification when work resumes in the quiet window', () => {
    // Why: Codex fires PermissionRequest at the human-input boundary *before* the
    // approval decision. Under "Approve for me" the review agent approves and
    // Codex resumes within the quiet window, so the OS notification must be
    // debounced and canceled — no false "approval required" banner (issue #8387).
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
      toolInput: 'git status'
    })

    // Visual status still updates immediately even though the notification waits.
    expect(dispatchHookLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'waiting', agentType: 'codex' })
    )
    expect(dispatchAttention).not.toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'git status'
    })
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)

    expect(dispatchAttention).not.toHaveBeenCalled()
  })

  it('dispatches the debounced Codex attention notification after the quiet window elapses', () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
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
    expect(dispatchAttention).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)

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
  })

  it('dispatches a non-Codex attention notification immediately without debounce', () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'cursor' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    // Non-Codex attention must not arm the debounce timer at all.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('debounces a blocked Codex pause like waiting and fires after the quiet window', () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'blocked', ...turn, toolName: 'exec_command' })
    expect(dispatchAttention).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)
    expect(dispatchAttention).toHaveBeenCalledTimes(1)
  })

  it('cancels the debounced Codex attention when a completion lands in the window (no double notify)', () => {
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
    // A 'done' completing the turn inside the window must cancel the pending
    // attention so the pause never co-fires with the completion notification.
    coordinator.observeHookStatus({ state: 'done', ...turn })
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)

    expect(dispatchAttention).not.toHaveBeenCalled()
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the pending Codex attention timer on dispose (no leak, no late fire)', () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'waiting', ...turn, toolName: 'exec_command' })
    expect(vi.getTimerCount()).toBe(1)

    coordinator.dispose()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)
    expect(dispatchAttention).not.toHaveBeenCalled()
  })

  it('re-arms and fires a second distinct Codex pause after work resumed', () => {
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'ls'
    })
    // First pause auto-resolves before the window elapses.
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'ls'
    })
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)
    expect(dispatchAttention).not.toHaveBeenCalled()

    // A later, genuinely-distinct pause must re-arm the debounce and fire.
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'apply_patch',
      toolInput: 'diff'
    })
    expect(dispatchAttention).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)
    expect(dispatchAttention).toHaveBeenCalledTimes(1)
  })

  it('cancels the debounced Codex attention when a working-spinner title resumes', () => {
    // Why: a Codex resume can surface as a working title before the resume
    // 'working' hook lands; that title must also cancel the pending attention
    // so the self-resolving pause never fires a false banner (issue #8387).
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: vi.fn(),
      dispatchAttention,
      isLive: () => true
    })

    const turn = { prompt: 'fix the bug', agentType: 'codex' as const }
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'waiting', ...turn, toolName: 'exec_command' })
    expect(vi.getTimerCount()).toBe(1)

    coordinator.observeTitleWorking()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(CODEX_ATTENTION_QUIET_MS)
    expect(dispatchAttention).not.toHaveBeenCalled()
  })

  it('does not let a null-foreground inspection blip drop the debounced Codex attention', async () => {
    // Why: guard for #8387 fail-open. In the pty-connection coordinator (real
    // process polling), a transient null/shell foreground blip — or a remote
    // inspection that cannot resolve the foreground — must not convert a genuine
    // Codex pause into a process-exit completion while the attention debounce is
    // still pending. Mirrors the pendingHookDoneTimer evidence-teardown guard.
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
    // First cadence poll recognizes Codex as the foreground agent (active tier).
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    // Codex pauses for a permission decision: the OS attention is debounced.
    const turn = { prompt: 'apply patch', agentType: 'codex' as const }
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'rm -rf build'
    })
    expect(dispatchAttention).not.toHaveBeenCalled()

    // Foreground reads null for the whole window; without the guard this would
    // land a false process-exit completion racing/duplicating the pause banner.
    foreground = null
    await vi.advanceTimersByTimeAsync(CODEX_ATTENTION_QUIET_MS + 100)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledTimes(1)
  })

  it('does not mutate completion state when hook completion is suppressed', () => {
    const dispatchCompletion = vi.fn()
    const shouldSuppressHookCompletion = vi.fn(
      (payload: { state: string }) => payload.state === 'waiting' || payload.state === 'blocked'
    )
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true,
      shouldSuppressHookCompletion
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'implement notifications',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'waiting',
      prompt: 'implement notifications',
      agentType: 'codex',
      toolName: 'exec_command',
      toolInput: 'git status'
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(shouldSuppressHookCompletion).toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'implement notifications',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000,
      lastAssistantMessage: 'Done.'
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
          agentType: 'codex'
        })
      })
    )
  })
})
