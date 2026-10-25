import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept, PANE_KEY } from '../../agent-hook-listener-test-harness'

const SESSION_ID = '01a0caa3-0e77-7d41-bad7-46283a45633d'
const TURN_ID = 'e495d1a5-59aa-47b4-8efb-a1bd75509afc'
const CHILD_ID = '1471f5e6-bd60-41a2-bfcf-c9086dbd4092'
const PROMPT_ID = '01a0caa3-a25a-7810-8229-4de04b2e7ca3'
const QUESTION = {
  id: 'fav_color',
  header: 'Color',
  question: 'What is your favorite color?',
  options: [{ label: 'Blue' }, { label: 'Green' }, { label: 'Red' }]
}

const envelope = {
  cwd: '/tmp/ws',
  transcript_path: null,
  model: 'muse-spark-1.3',
  permission_mode: 'default',
  model_provider: 'meta'
}
const main = { ...envelope, session_id: SESSION_ID, turn_id: TURN_ID }
const child = { ...envelope, session_id: CHILD_ID, turn_id: CHILD_ID }
const reminderInput = { decision: 'none', skill_id: 'bundled:grill' }

function sessionLogLine(event: Record<string, unknown>): string {
  return `${JSON.stringify({
    schema_version: 1,
    stream: { kind: 'session', id: SESSION_ID },
    record_type: 'event',
    payload_type: 'runtime.session',
    payload: { kind: 'run', run_id: TURN_ID, event }
  })}\n`
}

function childReminderHooks(): Record<string, unknown>[] {
  return [
    {
      ...child,
      hook_event_name: 'PreToolUse',
      tool_name: 'submit_reminder_decision',
      tool_input: reminderInput,
      tool_use_id: 'call_child'
    },
    {
      ...child,
      hook_event_name: 'PermissionRequest',
      tool_name: 'submit_reminder_decision',
      tool_input: reminderInput
    },
    {
      ...child,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'submit_reminder_decision',
      tool_input: reminderInput,
      error:
        'tool failed: invalid reminder decision payload: unexpected field `additionalProperties`'
    },
    { ...child, hook_event_name: 'SubagentStop', subagent_id: 'skill-reminder' }
  ]
}

describe('Muse hook events', () => {
  let state: HookListenerState
  let dataHome: string

  beforeEach(() => {
    state = createHookListenerState()
    dataHome = mkdtempSync(join(tmpdir(), 'muse-events-'))
    vi.stubEnv('XDG_DATA_HOME', dataHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dataHome, { recursive: true, force: true })
  })

  function sessionLogPath(): string {
    const date = new Date(Number.parseInt(SESSION_ID.replace(/-/g, '').slice(0, 12), 16))
    const dir = join(
      dataHome,
      'muse',
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      SESSION_ID
    )
    mkdirSync(dir, { recursive: true })
    return join(dir, 'session.jsonl')
  }

  it('drops reminder-subagent hooks announced by SubagentStart, even after Stop', () => {
    normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'list files'
    })
    const start = normalizeAndAccept(state, 'muse', {
      ...child,
      hook_event_name: 'SubagentStart',
      subagent_id: 'skill-reminder',
      child_session_id: CHILD_ID
    })
    expect(start).toBeNull()
    for (const hook of childReminderHooks()) {
      expect(normalizeAndAccept(state, 'muse', hook)).toBeNull()
    }

    const stopped = normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Here are the files.'
    })
    expect(stopped?.payload.state).toBe('done')
    for (const hook of childReminderHooks()) {
      expect(normalizeAndAccept(state, 'muse', hook)).toBeNull()
    }
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload).toMatchObject({
      state: 'done',
      lastAssistantMessage: 'Here are the files.'
    })
  })

  // Why: a SubagentStart that predates this listener (restart, relay reconnect) is never seen.
  it('drops child-session hooks whose turn id equals their session id without SubagentStart', () => {
    normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'done'
    })
    for (const hook of childReminderHooks()) {
      expect(normalizeAndAccept(state, 'muse', hook)).toBeNull()
    }
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
  })

  it('shows the approval card only once Muse notifies a permission prompt', () => {
    const bash = { command: 'rm -rf build' }
    normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_input: bash,
      tool_use_id: 'call_1'
    })
    expect(
      normalizeAndAccept(state, 'muse', {
        ...main,
        hook_event_name: 'PermissionRequest',
        tool_name: 'bash',
        tool_input: bash
      })
    ).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')

    const waiting = normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      title: 'ws — waiting for approval',
      message: 'bash wants to run rm -rf build'
    })
    expect(waiting?.payload).toMatchObject({
      agentType: 'muse',
      state: 'waiting',
      toolName: 'bash',
      interactivePrompt: JSON.stringify({ approval: { tool: 'bash', summary: 'rm -rf build' } })
    })

    const approved = normalizeAndAccept(state, 'muse', {
      ...main,
      hook_event_name: 'PostToolUse',
      tool_name: 'bash',
      tool_input: bash,
      tool_use_id: 'call_1'
    })
    expect(approved?.payload.state).toBe('working')
    expect(approved?.payload.interactivePrompt).toBeUndefined()
  })

  it('ignores Notification types other than permission_prompt', () => {
    expect(
      normalizeAndAccept(state, 'muse', {
        ...main,
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Muse is waiting for your input'
      })
    ).toBeNull()
  })

  it('reports a request_user_input question from the session log until it settles', () => {
    const logPath = sessionLogPath()
    const body = { ...main, hook_event_name: 'UserPromptSubmit', prompt: 'ask my favorite color' }
    const working = normalizeAndAccept(state, 'muse', body)
    expect(working?.payload.state).toBe('working')

    writeFileSync(
      logPath,
      sessionLogLine({
        kind: 'user_input_prompt_requested',
        prompt_id: PROMPT_ID,
        tool_name: 'request_user_input',
        questions: [QUESTION]
      })
    )
    const waiting = normalizeAndAccept(state, 'muse', body)
    expect(waiting?.payload).toMatchObject({
      agentType: 'muse',
      state: 'waiting',
      toolName: 'request_user_input',
      prompt: 'ask my favorite color',
      interactivePrompt: JSON.stringify({ questions: [QUESTION] })
    })

    appendFileSync(
      logPath,
      sessionLogLine({
        kind: 'user_input_prompt_settled',
        prompt_id: PROMPT_ID,
        outcome: 'answered',
        answers: [{ id: 'fav_color', selected_label: 'Blue' }]
      })
    )
    const answered = normalizeAndAccept(state, 'muse', body)
    expect(answered?.payload.state).toBe('working')
    expect(answered?.payload.interactivePrompt).toBeUndefined()
  })
})
