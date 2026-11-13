import { expect, it } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand
} from './structured-agent-session-composer'

it('routes /new through the host conversation clear instead of sending it to the agent', async () => {
  expect(isStructuredAgentSessionComposerCommand('/new', 'codex', [])).toBe(true)
  expect(
    await dispatchStructuredAgentSessionComposerCommand('/new', {
      agent: 'codex',
      snapshot: [],
      invokeAction: async () => true,
      setOption: async () => true,
      conversationCommands: ['clear'],
      runConversationCommand: async (command) => ({ accepted: command === 'clear', error: null })
    })
  ).toEqual({ handled: true, accepted: true, error: null })
})
