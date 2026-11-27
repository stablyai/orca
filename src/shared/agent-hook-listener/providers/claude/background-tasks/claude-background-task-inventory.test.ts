import { expect, it } from 'vitest'
import { createHookListenerState } from '../../../listener-state'
import { normalizeClaudeEvent } from '../claude-events'

it("finishes a turn that leaves only Claude's ambient artifact sockets running", () => {
  const stopWith = (description: string) => {
    const state = createHookListenerState()
    const send = (payload: Record<string, unknown>) =>
      normalizeClaudeEvent(state, payload.hook_event_name, '', 'pane', payload)
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'publish it' })
    return send({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'w1', type: 'monitor', status: 'running', description }]
    })
  }

  // Captured from Claude Code 2.1.332: its hook rows drop the ambient flag on monitor_ws tasks.
  for (const description of [
    'live updates for artifact https://claude.ai/artifact/abc (watch requested)',
    'presence on artifact https://claude.ai/artifact/abc'
  ]) {
    expect(stopWith(description)).toMatchObject({ state: 'done' })
  }
  expect(stopWith('Watch deploy events')).toMatchObject({
    state: 'working',
    workingMode: 'monitoring'
  })
})
