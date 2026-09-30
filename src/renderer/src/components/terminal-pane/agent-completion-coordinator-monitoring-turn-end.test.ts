import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../../../shared/agent-hook-listener/listener-state'
import {
  observeClaudeTranscript,
  syncClaudeTranscriptCursor
} from '../../../../shared/agent-hook-listener/providers/claude-transcript-watch'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
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

/** Claude's hooks for one transcript, through the real listener, as the host would accept them. */
function transcriptHooks(
  listener: ReturnType<typeof createHookListenerState>,
  sessionId: string,
  transcript: string
) {
  return (payload: Record<string, unknown>) => {
    const event = normalizeHookPayload(
      listener,
      'claude',
      {
        paneKey: PANE,
        payload: { session_id: sessionId, transcript_path: transcript, ...payload }
      },
      'production'
    )
    if (!event) {
      throw new Error('listener produced no event')
    }
    return event
  }
}

function taskNotification(taskId: string, toolUseId: string, status: string): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Task "Sleep" ${status}</summary>\n</task-notification>`
}

/** The line Claude appends to its transcript when a background task ends. */
function taskEndLine(taskId: string, toolUseId: string, status: string): string {
  return `${JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-09-29T05:24:58.227Z',
    content: taskNotification(taskId, toolUseId, status)
  })}\n`
}

/** One watch tick after the host stored `accepted`: the row it publishes. */
function watchRow(
  listener: ReturnType<typeof createHookListenerState>,
  accepted: AgentHookEventPayload
) {
  seedLegacyAgentStatusForTests(listener, accepted)
  syncClaudeTranscriptCursor(listener, accepted)
  const observed = observeClaudeTranscript(listener, PANE)
  return observed.kind === 'read' ? observed.row : undefined
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

  it('does not announce again when Claude records a /tasks kill with no hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-completion-tasks-kill-'))
    try {
      const transcript = join(dir, 'session.jsonl')
      writeFileSync(transcript, '')
      const listener = createHookListenerState()
      const { coordinator, dispatchCompletion } = createCoordinator()
      // Shapes from the r1-s9 capture (claude-background-shell-tasks-kill-idle-hooks.jsonl).
      const hook = transcriptHooks(listener, '00000000-0000-4000-8000-0000b2000000', transcript)
      const observe = (payload: AgentHookEventPayload['payload']) =>
        coordinator.observeHookStatus({ ...payload, stateStartedAt: 1_700_000_000_000 })
      observe(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start it' }).payload)
      observe(
        hook({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { backgroundTaskId: 'bmkj8eeoi' },
          tool_use_id: 'toolu_012Evdwg71Lm1f4XM5vSqWvf'
        }).payload
      )
      const stop = hook({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'bmkj8eeoi', type: 'shell', status: 'running' }]
      })
      observe(stop.payload)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)

      // The host stores the Stop's row and watches for the shell's end line.
      seedLegacyAgentStatusForTests(listener, stop)
      expect(syncClaudeTranscriptCursor(listener, stop)).toBe(true)
      appendFileSync(
        transcript,
        taskEndLine('bmkj8eeoi', 'toolu_012Evdwg71Lm1f4XM5vSqWvf', 'killed')
      )
      const observed = observeClaudeTranscript(listener, PANE)
      if (observed.kind !== 'read' || !observed.row) {
        throw new Error('the watch published no row')
      }
      expect(observed.row.payload).toMatchObject({
        state: 'done',
        turnCompletedAt: stop.payload.turnCompletedAt
      })
      observe(observed.row.payload)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('a shell that outlives /clear', () => {
    // Shapes from the r3-clear-run1 capture (claude-background-shell-clear-hooks.jsonl).
    const TASK = 'bw6tpm92k'
    const LAUNCH_ID = 'toolu_01WS3SC8DmyVLGRwffFfzh9f'

    function clearedWithShell(dir: string) {
      const first = join(dir, 'first.jsonl')
      const cleared = join(dir, 'cleared.jsonl')
      writeFileSync(first, '')
      const listener = createHookListenerState()
      const { coordinator, dispatchCompletion } = createCoordinator()
      const observe = (payload: AgentHookEventPayload['payload']) => {
        coordinator.observeHookStatus({ ...payload, stateStartedAt: 1_700_000_000_000 })
        vi.advanceTimersByTime(10_000)
      }
      const hook = transcriptHooks(listener, '00000000-0000-4000-8000-0000b4000000', first)
      observe(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'start it' }).payload)
      observe(
        hook({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_response: { backgroundTaskId: TASK },
          tool_use_id: LAUNCH_ID
        }).payload
      )
      observe(
        hook({
          hook_event_name: 'Stop',
          background_tasks: [{ id: TASK, type: 'shell', status: 'running' }]
        }).payload
      )
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
      const afterClear = transcriptHooks(listener, '00000000-0000-4000-8000-0000b4000005', cleared)
      const start = afterClear({ hook_event_name: 'SessionStart', source: 'clear' })
      observe(start.payload)
      expect(start.payload).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      // The host stores the SessionStart's row and waits for the new session's file.
      expect(watchRow(listener, start)).toBeUndefined()
      writeFileSync(cleared, '')
      return { listener, cleared, start, afterClear, observe, dispatchCompletion }
    }

    it('does not announce again when it is killed from /tasks before any prompt', () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-completion-clear-'))
      try {
        const { listener, cleared, start, observe, dispatchCompletion } = clearedWithShell(dir)
        appendFileSync(cleared, taskEndLine(TASK, LAUNCH_ID, 'killed'))
        const settled = watchRow(listener, start)
        if (!settled) {
          throw new Error('the watch published no row')
        }
        expect(settled.payload.state).toBe('done')
        observe(settled.payload)

        expect(dispatchCompletion).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // The capture's write order: the end line is on disk before the notification turn's prompt hook.
    it("announces Claude's own notification turn once when the end line comes first", () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-completion-clear-'))
      try {
        const { listener, cleared, start, afterClear, observe, dispatchCompletion } =
          clearedWithShell(dir)
        appendFileSync(cleared, taskEndLine(TASK, LAUNCH_ID, 'completed'))
        const settled = watchRow(listener, start)
        if (!settled) {
          throw new Error('the watch published no row')
        }
        expect(settled.payload.state).toBe('done')
        observe(settled.payload)
        expect(dispatchCompletion).toHaveBeenCalledTimes(1)
        observe(
          afterClear({
            hook_event_name: 'UserPromptSubmit',
            prompt: taskNotification(TASK, LAUNCH_ID, 'completed')
          }).payload
        )
        observe(afterClear({ hook_event_name: 'Stop', background_tasks: [] }).payload)

        expect(dispatchCompletion).toHaveBeenCalledTimes(2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // Also reached: Orca may handle the prompt's hook before the watch reads the end line.
    it("announces Claude's own notification turn once when its prompt comes first", () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-completion-clear-'))
      try {
        const { listener, cleared, afterClear, observe, dispatchCompletion } = clearedWithShell(dir)
        const opened = afterClear({
          hook_event_name: 'UserPromptSubmit',
          prompt: taskNotification(TASK, LAUNCH_ID, 'completed')
        })
        observe(opened.payload)
        appendFileSync(cleared, taskEndLine(TASK, LAUNCH_ID, 'completed'))
        const retired = watchRow(listener, opened)
        if (!retired) {
          throw new Error('the watch published no row')
        }
        expect(retired.payload).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
        expect(retired.claudeRunningNonAgentTask).toBe(false)
        observe(retired.payload)
        expect(dispatchCompletion).toHaveBeenCalledTimes(1)
        observe(afterClear({ hook_event_name: 'Stop', background_tasks: [] }).payload)

        expect(dispatchCompletion).toHaveBeenCalledTimes(2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
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
