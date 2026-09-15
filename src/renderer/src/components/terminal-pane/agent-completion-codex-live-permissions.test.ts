import { describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { PANE_KEY } from '../../../../shared/agent-hook-listener-test-harness'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'

function setup() {
  const dispatchAttention = vi.fn()
  const dispatchCompletion = vi.fn()
  const dispatchHookLifecycle = vi.fn()
  const coordinator = createAgentCompletionCoordinator({
    paneKey: PANE_KEY,
    getPtyId: () => 'synthetic-pty',
    getSettings: () => null,
    inspectProcess: vi.fn(),
    dispatchAttention,
    dispatchCompletion,
    dispatchHookLifecycle,
    isLive: () => true
  })
  const state = createHookListenerState()
  function hook(eventName: string, permissionMode = 'bypassPermissions', toolName = 'Bash') {
    const event = normalizeHookPayload(
      state,
      'codex',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: eventName,
          permission_mode: permissionMode,
          tool_name: toolName,
          tool_input:
            toolName === 'Bash'
              ? { command: 'sleep 10' }
              : { questions: [{ id: 'choice', header: 'Choice', question: 'Which option?' }] }
        }
      },
      'production'
    )
    if (!event) {
      throw new Error('Expected a normalized Codex event')
    }
    coordinator.observeHookStatus(event.payload)
    return event.payload
  }
  return { coordinator, hook, dispatchAttention, dispatchCompletion, dispatchHookLifecycle }
}

describe('Codex live permission hooks through attention dispatch', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('does not notify for a noninteractive command running longer than the debounce', () => {
    const { coordinator, hook, dispatchAttention, dispatchCompletion, dispatchHookLifecycle } =
      setup()
    try {
      hook('PreToolUse')
      const permission = hook('PermissionRequest')
      // No further hook arrives while the noninteractive ten-second command runs.
      for (let sample = 0; sample < 5; sample++) {
        vi.advanceTimersByTime(2_000)
        expect(dispatchAttention).not.toHaveBeenCalled()
        expect(permission.state).toBe('working')
        expect(permission.interactivePrompt).toBeUndefined()
        expect(dispatchCompletion).not.toHaveBeenCalled()
        expect(dispatchHookLifecycle).not.toHaveBeenCalledWith(
          expect.objectContaining({ state: 'waiting' })
        )
      }
      hook('PostToolUse')
      vi.advanceTimersByTime(2_000)
      expect(dispatchAttention).not.toHaveBeenCalled()
    } finally {
      coordinator.dispose()
    }
  })

  it.each([
    ['PermissionRequest', 'default', 'Bash'],
    ['PermissionRequest', 'unknown', 'Bash'],
    ['PreToolUse', 'bypassPermissions', 'request_user_input'],
    ['PermissionRequest', 'bypassPermissions', 'request_user_input']
  ])('notifies for an unanswered human %s in %s (%s)', (eventName, mode, toolName) => {
    const { coordinator, hook, dispatchAttention, dispatchCompletion } = setup()
    try {
      hook('PreToolUse')
      hook(eventName, mode, toolName)
      vi.advanceTimersByTime(1_499)
      expect(dispatchAttention).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(dispatchAttention).toHaveBeenCalledExactlyOnceWith(
        'codex',
        expect.objectContaining({
          agentStatus: expect.objectContaining({ state: 'waiting', toolName })
        })
      )
      vi.advanceTimersByTime(8_500)
      expect(dispatchAttention).toHaveBeenCalledTimes(1)
      expect(dispatchCompletion).not.toHaveBeenCalled()
    } finally {
      coordinator.dispose()
    }
  })
})
