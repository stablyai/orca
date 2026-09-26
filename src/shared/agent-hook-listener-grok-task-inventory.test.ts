// Grok's background-task inventory between `stop` reports: a shell's own start (PostToolUse
// BackgroundTaskStarted) and end (Notification task_complete) hooks. Measured on 1.0.41:
// src/shared/__fixtures__/grok-cancel-subagent-dialog-hooks.jsonl and
// grok-background-completion-hooks.jsonl.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

function readCapture(name: string): unknown[] {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((raw): unknown => JSON.parse(raw))
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capturedHookPayload(index: number): Record<string, unknown> {
  const line = readCapture('grok-cancel-subagent-dialog-hooks').find(
    (record) =>
      typeof record === 'object' &&
      record !== null &&
      'kind' in record &&
      record.kind === 'hook' &&
      'index' in record &&
      record.index === index
  )
  const payload =
    typeof line === 'object' && line !== null && 'payload' in line ? line.payload : undefined
  if (!isPayload(payload)) {
    throw new Error(`Captured Grok hook ${index} not found`)
  }
  return payload
}

const taskComplete = (taskId: string) => ({
  hookEventName: 'notification',
  sessionId: 's-1',
  notificationType: 'task_complete',
  message: `Background task completed: ${taskId}`,
  level: 'info'
})

describe('Grok background-task inventory between stop reports', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function normalize(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'grok', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  function settleWithShell(promptId: string): void {
    normalize({ hookEventName: 'user_prompt_submit', sessionId: 's-1', promptId, prompt: 'go' })
    expect(
      normalize({
        hookEventName: 'stop',
        sessionId: 's-1',
        promptId,
        reason: 'end_turn',
        backgroundTasks: [
          { id: 'task-1', type: 'shell', status: 'running', command: 'sleep 30' },
          { id: 'monitor-1', type: 'monitor', status: 'running', description: 'watch' }
        ]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring' })
  }

  it('drops a shell that completes during a live turn without changing the row', () => {
    settleWithShell('prompt-1')
    normalize({
      hookEventName: 'user_prompt_submit',
      sessionId: 's-1',
      promptId: 'prompt-2',
      prompt: 'more'
    })
    // The live turn owns the row; the completion only updates the inventory.
    expect(normalize(taskComplete('task-1'))).toBeUndefined()
    // The inventory-less cancel then finds nothing left running.
    expect(
      normalize({
        hookEventName: 'stop_cancelled',
        sessionId: 's-1',
        promptId: 'prompt-2',
        reason: 'user_interrupt'
      })
    ).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('ignores a completion for a task the inventory never held, and for a monitor', () => {
    settleWithShell('prompt-1')
    expect(normalize(taskComplete('monitor-1'))).toBeUndefined()
    expect(normalize(taskComplete('task-unknown'))).toBeUndefined()
    expect(
      normalize({ ...taskComplete('task-1'), message: 'Background task finished: task-1' })
    ).toBeUndefined()
    // The shell still holds the settled row.
    expect(
      normalize({
        hookEventName: 'notification',
        sessionId: 's-1',
        notificationType: 'idle_prompt'
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    // Its own completion settles it; a plain stop carries no cancel verdict.
    const settled = normalize(taskComplete('task-1'))
    expect(settled).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(settled?.interrupted).toBeUndefined()
  })

  it("does not add a subagent's own background shell to the parent's inventory", () => {
    const childStarted = capturedHookPayload(12)
    expect(childStarted.subagentType).toBe('general-purpose')
    expect(childStarted.toolResult).toMatchObject({
      type: 'BackgroundTaskStarted',
      task_type: 'bash'
    })
    normalize({
      hookEventName: 'user_prompt_submit',
      sessionId: 's-1',
      promptId: 'prompt-1',
      prompt: 'go'
    })
    expect(normalize(childStarted)).toBeUndefined()
    expect(
      normalize({
        hookEventName: 'stop_cancelled',
        sessionId: 's-1',
        promptId: 'prompt-1',
        reason: 'user_interrupt'
      })
    ).toMatchObject({ state: 'done', interrupted: true })
  })

  it('stamps the held-open turn at idle with its stop time, and a re-delivered stop keeps it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    normalize({ hookEventName: 'user_prompt_submit', sessionId: 's-1', promptId: 'p1' })
    const stop = {
      hookEventName: 'stop',
      sessionId: 's-1',
      promptId: 'p1',
      reason: 'end_turn',
      backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running' }]
    }
    vi.setSystemTime(2_000)
    expect(normalize(stop)?.turnCompletedAt).toBeUndefined()
    vi.setSystemTime(62_000)
    expect(
      normalize({
        hookEventName: 'notification',
        sessionId: 's-1',
        notificationType: 'idle_prompt'
      })
    ).toMatchObject({ state: 'working', turnCompletedAt: 2_000 })
    vi.setSystemTime(62_250)
    expect(normalize(stop)?.turnCompletedAt).toBe(2_000)
  })

  // Why: Grok may run no follow-up turn after a completion (a cancel, a goal loop, auto-wake off),
  // so the task's own end settles the row; when it does wake, the woken turn reopens it.
  it('settles on the captured task_complete and reopens for the woken follow-up turn', () => {
    const states = readCapture('grok-background-completion-hooks')
      .filter(isPayload)
      .slice(0, 8)
      .map((payload) => {
        const row = normalize(payload)
        return [payload.hookEventName, payload.notificationType, row?.state, row?.workingMode]
      })
    expect(states).toEqual([
      ['session_start', undefined, undefined, undefined],
      ['user_prompt_submit', undefined, 'working', undefined],
      ['pre_tool_use', undefined, 'working', undefined],
      ['post_tool_use', undefined, 'working', undefined],
      ['stop', undefined, 'working', 'monitoring'],
      ['notification', 'task_complete', 'done', undefined],
      ['user_prompt_submit', undefined, 'working', undefined],
      ['stop', undefined, 'done', undefined]
    ])
  })
})
