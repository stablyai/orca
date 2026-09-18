import { expect, it } from 'vitest'
import { normalizeDshConsoleEvent } from './dsh-console-events'

it('normalizes complete DSH snapshots and rejects unknown lifecycle events', () => {
  expect(normalizeDshConsoleEvent('session_start', { state: 'done' })).toBeNull()
  expect(normalizeDshConsoleEvent('invented', { state: 'done' })).toBeNull()
  expect(
    normalizeDshConsoleEvent('Interaction', { state: 'blocked', prompt: 'task', tool_name: 'bash' })
  ).toMatchObject({ state: 'blocked', prompt: 'task', agentType: 'dsh-console', toolName: 'bash' })
  expect(
    normalizeDshConsoleEvent('Stop', {
      state: 'done',
      prompt: 'task',
      last_assistant_message: 'finished',
      is_interrupt: true,
      turn_completed_at: 1234
    })
  ).toMatchObject({
    state: 'done',
    lastAssistantMessage: 'finished',
    interrupted: true,
    turnCompletedAt: 1234
  })
})
