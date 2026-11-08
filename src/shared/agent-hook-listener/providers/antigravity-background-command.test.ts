import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../listener-state'
import { normalizeHookPayload } from '../normalization/normalize-hook-payload'
import { PANE_KEY } from '../normalization/agent-hook-listener-test-harness'

// Hook order captured from agy 1.5.2 when the model backgrounds run_command (WaitMsBeforeAsync 500).
const turn = { conversationId: 'parent', lastUserInput: 'start the job' }
const command = {
  ...turn,
  stepIdx: 2,
  toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600', IsDaemon: false } }
}

function replay(events: [string, Record<string, unknown>][]) {
  const state = createHookListenerState()
  return events.map(
    ([name, payload]) =>
      normalizeHookPayload(
        state,
        'antigravity',
        { paneKey: PANE_KEY, hook_event_name: name, payload },
        'production'
      )?.payload ?? null
  )
}

describe('Antigravity background commands', () => {
  it('hold the turn as monitoring until the command ends and agy stops fully idle', () => {
    const events = replay([
      ['PreInvocation', turn],
      ['PreToolUse', command],
      ['PostInvocation', turn],
      ['Stop', { ...turn, fullyIdle: false, terminationReason: 'NO_TOOL_CALL' }],
      // Sent when the backgrounded command exits; agy then wakes the parent.
      ['PostToolUse', command],
      ['PreInvocation', turn],
      ['Stop', { ...turn, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }]
    ])
    expect(events[3]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(events[4]?.workingMode).toBeUndefined()
    expect(events[4]?.mainAgent).toBeUndefined()
    expect(events[6]?.state).toBe('done')
  })
})
