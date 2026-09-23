import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

const capturedHooks = readFileSync(
  join(__dirname, '__fixtures__', 'grok-background-completion-hooks.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map(parseCapturedHook)

function parseCapturedHook(line: string): Record<string, unknown> {
  // JSON.parse returns any; the runtime guard below is what actually proves the shape.
  const parsed: Record<string, unknown> = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Captured Grok hook must be an object')
  }
  return parsed
}

function capturedHook(predicate: (payload: Record<string, unknown>) => boolean) {
  const hook = capturedHooks.find(predicate)
  if (!hook) {
    throw new Error('Captured Grok hook not found')
  }
  return hook
}

describe('Grok completion observations', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function normalize(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'grok', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('keeps the captured pane working until the finite task follow-up settles', () => {
    const lead = normalize(
      capturedHook(
        (hook) =>
          hook.hookEventName === 'stop' && hook.promptId === '8e3fbed9-8839-49a3-8078-0fc261228383'
      )
    )
    const followUp = normalize(
      capturedHook(
        (hook) =>
          hook.hookEventName === 'stop' && String(hook.promptId).startsWith('task-completed-')
      )
    )

    expect(lead).toMatchObject({
      state: 'working',
      workingMode: 'monitoring'
    })
    expect(followUp).toMatchObject({
      state: 'done',
      workingMode: undefined
    })
  })

  it('marks the captured shutdown SessionEnd and trailing Stop as session boundaries', () => {
    const sessionEnd = normalize(
      capturedHook((hook) => hook.hookEventName === 'session_end' && hook.reason === 'shutdown')
    )
    const shutdownStop = normalize(
      capturedHook(
        (hook) =>
          hook.hookEventName === 'stop' &&
          hook.reason === 'shutdown' &&
          !Object.hasOwn(hook, 'backgroundTasks')
      )
    )

    expect(sessionEnd).toMatchObject({
      state: 'done',
      sessionBoundary: true
    })
    expect(shutdownStop).toMatchObject({
      state: 'done',
      sessionBoundary: true
    })
    expect(
      normalize({
        hookEventName: 'Stop',
        reason: 'shutdown',
        stopHookActive: true,
        backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running' }]
      })
    ).toMatchObject({ state: 'done', sessionBoundary: true })
  })

  it('settles a lead StopFailure without requiring background inventory', () => {
    expect(
      normalize({
        hookEventName: 'StopFailure',
        error: 'server_error',
        errorDetails: 'upstream failed',
        lastAssistantMessage: 'The request failed.'
      })
    ).toMatchObject({
      state: 'done'
    })
  })

  it('settles a lead StopCancelled as interrupted', () => {
    expect(
      normalize({
        hookEventName: 'StopCancelled',
        reason: 'user_interrupt',
        cancelledBy: 'user',
        cancelTrigger: 'stop_gesture',
        reasonDetails: 'user interrupted the turn',
        lastAssistantMessage: 'Stopped by user.'
      })
    ).toMatchObject({
      state: 'done',
      interrupted: true,
      lastAssistantMessage: 'Stopped by user.'
    })
  })

  // Pins grok-events.ts: finite task predicate and sessionCrons omission; treating monitors/crons as finite must redden.
  it.each([
    {
      label: 'monitor-only',
      backgroundTasks: [
        { id: 'monitor-1', type: 'monitor', status: 'running', description: 'watch the build' }
      ],
      sessionCrons: []
    },
    {
      label: 'cron-only',
      backgroundTasks: [],
      sessionCrons: [
        { id: 'cron-1', schedule: 'every minute', recurring: true, prompt: 'check the build' }
      ]
    }
  ])('settles when outstanding work is $label', ({ backgroundTasks, sessionCrons }) => {
    expect(
      normalize({
        hookEventName: 'Stop',
        reason: 'end_turn',
        stopHookActive: false,
        backgroundTasks,
        sessionCrons
      })?.state
    ).toBe('done')
  })

  // Legacy Grok versions omit both fields, so only positive finite-work evidence may hold the row.
  it.each([
    {},
    { backgroundTasks: { unexpected: true } },
    { backgroundTasks: [{ type: 'future-task', status: 'running' }] },
    { backgroundTasks: [], stopHookActive: 'true' },
    { background_tasks: [], stop_hook_active: false }
  ])('fails open for unknown or legacy optional fields %#', (payload) => {
    expect(
      normalize({
        hookEventName: 'Stop',
        reason: 'end_turn',
        stopHookActive: false,
        ...payload
      })?.state
    ).toBe('done')
  })

  it('keeps ambiguous continuation Stops working and settles on the idle backstop', () => {
    normalize({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      promptId: 'prompt-1',
      prompt: 'finish the request'
    })
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        reason: 'end_turn',
        backgroundTasks: [],
        stopHookActive: true
      })?.state
    ).toBe('working')
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        reason: 'end_turn',
        backgroundTasks: [],
        stopHookActive: true
      })?.state
    ).toBe('working')
    expect(
      normalize({ hookEventName: 'Notification', notificationType: 'idle_prompt' })?.state
    ).toBe('done')
  })

  it('keeps a starting finite task working until a later terminal observation', () => {
    expect(
      normalize({
        hookEventName: 'Stop',
        backgroundTasks: [{ id: 'task-1', type: 'subagent', status: 'starting' }]
      })
    ).toMatchObject({ state: 'working', workingMode: undefined })
  })

  // `workingMode: 'monitoring'` promises no foreground execution is owed, so a live subagent
  // cannot carry it: a consumer that reads it decides real agent work needs nothing from the host.
  it('leaves a live subagent as plain working, and marks only shells monitoring', () => {
    expect(
      normalize({
        hookEventName: 'Stop',
        backgroundTasks: [{ id: 'task-1', type: 'subagent', status: 'running' }]
      })
    ).toMatchObject({ state: 'working', workingMode: undefined })
    expect(
      normalize({
        hookEventName: 'Stop',
        backgroundTasks: [{ id: 'task-2', type: 'shell', status: 'running' }]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring' })
  })

  it('does not call a pane monitoring while a subagent runs beside a shell', () => {
    expect(
      normalize({
        hookEventName: 'Stop',
        backgroundTasks: [
          { id: 'task-1', type: 'subagent', status: 'running' },
          { id: 'task-2', type: 'shell', status: 'running' }
        ]
      })
    ).toMatchObject({ state: 'working', workingMode: undefined })
  })

  // A blocked Stop hook with an empty inventory means the model's own loop is still running and
  // there is no background work at all, which is the opposite of monitoring.
  it('does not call a blocked Stop hook monitoring', () => {
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        reason: 'end_turn',
        backgroundTasks: [],
        stopHookActive: true
      })
    ).toMatchObject({ state: 'working', workingMode: undefined })
    expect(
      normalize({
        hookEventName: 'Stop',
        backgroundTasks: [{ id: 'task-1', type: 'shell', status: 'running' }],
        stopHookActive: true
      })
    ).toMatchObject({ state: 'working', workingMode: undefined })
  })

  it('uses only idle_prompt, not task_complete text, as the session-idle backstop', () => {
    const taskComplete = normalize(
      capturedHook((hook) => hook.notificationType === 'task_complete')
    )
    const idlePrompt = normalize(capturedHook((hook) => hook.notificationType === 'idle_prompt'))
    const idlePromptWithQuestionCopy = normalize({
      hookEventName: 'Notification',
      notificationType: 'idle_prompt',
      message: 'Grok needs your feedback before the next prompt'
    })
    const agentError = normalize({
      hookEventName: 'Notification',
      notificationType: 'agent_error',
      message: 'The agent failed unexpectedly.',
      level: 'error'
    })

    expect(taskComplete).toBeUndefined()
    expect(idlePrompt?.state).toBe('done')
    expect(idlePromptWithQuestionCopy?.state).toBe('done')
    expect(agentError).toBeUndefined()
  })

  it('ignores a delayed cancellation from the turn replaced by a newer prompt', () => {
    normalize({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      promptId: 'prompt-old',
      prompt: 'old turn'
    })
    normalize({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      promptId: 'prompt-new',
      prompt: 'new turn'
    })

    expect(
      normalize({
        hookEventName: 'StopCancelled',
        sessionId: 'session-1',
        promptId: 'prompt-old',
        reason: 'user_interrupt'
      })
    ).toBeUndefined()
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        promptId: 'prompt-new',
        reason: 'end_turn'
      })?.state
    ).toBe('done')
  })

  it('rejects an identified old turn end after an id-less replacement prompt', () => {
    normalize({
      hookEventName: 'UserPromptSubmit',
      sessionId: 'session-1',
      promptId: 'prompt-old',
      prompt: 'old turn'
    })
    const replacement = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'UserPromptSubmit',
          sessionId: 'session-1',
          promptId: '\u0000invalid',
          prompt: 'new turn'
        }
      },
      'production'
    )
    expect(replacement).toMatchObject({
      grokPromptBoundary: true,
      payload: { state: 'working', prompt: 'new turn' }
    })
    expect(replacement?.providerPromptId).toBeUndefined()

    expect(
      normalize({
        hookEventName: 'StopCancelled',
        sessionId: 'session-1',
        promptId: 'prompt-old',
        reason: 'user_interrupt'
      })
    ).toBeUndefined()
    expect(
      normalize({
        hookEventName: 'Stop',
        sessionId: 'session-1',
        reason: 'end_turn'
      })?.state
    ).toBe('done')
  })

  it('carries the active Grok prompt boundary through hooks without ids', () => {
    const event = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'UserPromptSubmit',
          sessionId: 'session-1',
          promptId: '  prompt-new  ',
          prompt: 'new turn'
        }
      },
      'production'
    )

    expect(event).toMatchObject({
      providerPromptId: 'prompt-new',
      grokPromptBoundary: true
    })

    const toolEvent = normalizeHookPayload(
      state,
      'grok',
      {
        paneKey: PANE_KEY,
        payload: {
          hookEventName: 'PreToolUse',
          sessionId: 'session-1',
          toolName: 'run_terminal_command'
        }
      },
      'production'
    )
    expect(toolEvent).toMatchObject({
      providerPromptId: 'prompt-new',
      grokPromptBoundary: true
    })
  })

  it.each(['Stop', 'StopFailure', 'StopCancelled', 'SessionEnd'])(
    'ignores child-session %s events',
    (hookEventName) => {
      expect(
        normalize({
          hookEventName,
          subagentType: 'explore',
          promptId: 'child-prompt',
          lastAssistantMessage: 'child finished'
        })
      ).toBeUndefined()
    }
  )

  it('settles an unseen prompt id and a session-scoped idle event', () => {
    expect(
      normalize({
        hookEventName: 'StopCancelled',
        sessionId: 'session-1',
        promptId: 'bash-mode-prompt',
        reason: 'user_interrupt'
      })?.state
    ).toBe('done')
    expect(
      normalize({ hookEventName: 'Notification', notificationType: 'idle_prompt' })?.state
    ).toBe('done')
  })

  // Pins grok-events.ts: permission/question branch ordering; gating waiting notifications on background work must redden.
  it('leaves the real ask-user-question notification path ungated', () => {
    expect(
      normalize({
        hookEventName: 'Notification',
        notificationType: 'elicitation_dialog',
        message: 'User question requested',
        level: 'info'
      })
    ).toMatchObject({ state: 'waiting', agentType: 'grok' })
  })
})
