import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

// Grok 1.0.70 hooks captured around a confirmed Ctrl+C cancel; StopCancelled carries no backgroundTasks.
const capturedHooks: Record<string, unknown>[] = readFileSync(
  join(__dirname, '__fixtures__', 'grok-cancel-background-hooks.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

// Orca's managed Grok hooks do not subscribe SubagentStart/SubagentStop.
const UNSUBSCRIBED = new Set(['subagent_start', 'subagent_stop'])

function replay(scenario: string, edit = (hooks: Record<string, unknown>[]) => hooks) {
  const state = createHookListenerState()
  const sessions = new Set<string>()
  const rows = edit(
    capturedHooks.filter(
      (hook) => hook.scenario === scenario && !UNSUBSCRIBED.has(String(hook.hookEventName))
    )
  ).flatMap((hook) => {
    const event = normalizeAndAccept(state, 'grok', hook)
    const row = event?.payload
    if (!row) {
      return []
    }
    sessions.add(String(event.providerSession?.id))
    const name = hook.subagentType
      ? `child ${String(hook.hookEventName)}`
      : String(hook.notificationType ?? hook.hookEventName)
    const status = [row.state, row.workingMode, row.interrupted ? 'interrupted' : undefined]
    return [`${name}: ${status.filter(Boolean).join(' ')}`]
  })
  // A child's end restates the pane; resume must stay on the main session, never the subagent's.
  expect(sessions.size).toBe(1)
  return rows
}

describe('Grok background work that outlives a cancel', () => {
  it('keeps a kept-running subagent and shell visible until each reports its end', () => {
    expect(replay('continue-to-run')).toEqual([
      'user_prompt_submit: working',
      'pre_tool_use: working',
      'post_tool_use: working',
      'pre_tool_use: working',
      'post_tool_use: working',
      'pre_tool_use: working',
      'stop_cancelled: working',
      'idle_prompt: working',
      'child session_end: working monitoring',
      // Grok's own follow-up turn once the subagent finished.
      'user_prompt_submit: working',
      'pre_tool_use: working'
    ])
  })

  it('holds a cancelled turn on its shell until task_complete names it', () => {
    expect(replay('shell-only')).toEqual([
      'user_prompt_submit: working',
      'pre_tool_use: working',
      'post_tool_use: working',
      'pre_tool_use: working',
      'post_tool_use: working',
      'pre_tool_use: working',
      'stop_cancelled: working monitoring',
      'task_complete: done interrupted',
      'idle_prompt: done interrupted'
    ])
  })

  it('settles when "Stop running" ends the subagent with the cancel', () => {
    expect(replay('stop-running')).toEqual([
      'user_prompt_submit: working',
      'pre_tool_use: working',
      'post_tool_use: working',
      'pre_tool_use: working',
      'stop_cancelled: working',
      'child session_end: done interrupted',
      'idle_prompt: done interrupted'
    ])
  })

  it('lets a session that ended first stay settled when its subagent ends later', () => {
    const rows = replay('continue-to-run', (hooks) => {
      const childEnd = hooks.findIndex(
        (hook) => hook.subagentType && hook.hookEventName === 'session_end'
      )
      const { sessionId } = hooks[0]
      const mainEnd = { hook_event_name: 'SessionEnd', hookEventName: 'session_end', sessionId }
      return [...hooks.slice(0, childEnd), mainEnd, hooks[childEnd]]
    })
    expect(rows.at(-1)).toBe('session_end: done interrupted')
  })
})
