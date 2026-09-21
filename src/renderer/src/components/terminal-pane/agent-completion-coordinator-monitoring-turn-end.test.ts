import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../shared/stable-pane-id'

// Why: STA-4119's second complaint is the missing completion notification. This drives the REAL
// hook listener and feeds its real output into the REAL coordinator, rather than hand-writing a
// payload — the whole question is whether the two layers actually agree about a monitoring turn.
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const RUNNING_SHELL = {
  id: 'shell-1',
  type: 'shell',
  status: 'running',
  description: 'Run the dev server',
  command: 'pnpm dev'
}

function hookPayload(
  state: ReturnType<typeof createHookListenerState>,
  payload: Record<string, unknown>
) {
  const parsed = normalizeHookPayload(
    state,
    'claude',
    { paneKey: PANE, payload },
    'production'
  )?.payload
  if (!parsed) {
    throw new Error('listener produced no payload')
  }
  // The hook server stamps stateStartedAt on the way to the renderer.
  return { ...parsed, stateStartedAt: 1_700_000_000_000 }
}

function createCoordinator() {
  const dispatchCompletion = vi.fn()
  const dispatchHookLifecycle = vi.fn()
  const coordinator = createAgentCompletionCoordinator({
    paneKey: PANE,
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: vi.fn(),
    dispatchCompletion,
    dispatchHookLifecycle,
    isLive: () => true
  })
  return { coordinator, dispatchCompletion, dispatchHookLifecycle }
}

/** Meta the coordinator hands the notification dispatcher. */
function completionMeta(dispatchCompletion: ReturnType<typeof vi.fn>) {
  return dispatchCompletion.mock.calls[0]?.[1] as
    | { source?: string; agentStatus?: { state?: string; workingMode?: string } }
    | undefined
}

describe('completion notification when a lead turn ends into monitoring', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('announces completion when the turn ends but the pane stays working for a background shell', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion, dispatchHookLifecycle } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
    )
    const monitoring = hookPayload(listener, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    // Precondition: the pane really is in the monitoring state, not done.
    expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(typeof monitoring.turnCompletedAt).toBe('number')

    coordinator.observeHookStatus(monitoring)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    const meta = completionMeta(dispatchCompletion)
    expect(meta?.source).toBe('hook')
    // Why: the announcement is a synthesized `done` while the reported row stays `working` —
    // the notification follows the TURN boundary, not the rendered state.
    expect(meta?.agentStatus?.state).toBe('done')
    // Why: announce only. Running pane lifecycle here would settle a pane that is still working.
    expect(dispatchHookLifecycle).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done' })
    )
  })

  it('does not announce twice when the background shell later clears to done', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
    )
    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    )
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    // The shell exits; the same turn's all-clear must not re-announce.
    coordinator.observeHookStatus(
      hookPayload(listener, {
        hook_event_name: 'PostToolUse',
        tool_name: 'KillShell',
        background_tasks: []
      })
    )

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not announce mid-turn while the agent is still working in the foreground', () => {
    const listener = createHookListenerState()
    const { coordinator, dispatchCompletion } = createCoordinator()

    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    )
    coordinator.observeHookStatus(
      hookPayload(listener, { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    )

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })
})
