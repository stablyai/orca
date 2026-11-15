import { expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from './structured-agent-session-composer'

it('runs /new as the host conversation clear', async () => {
  const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
  const outcome = await dispatchStructuredAgentSessionComposerCommand('/new', {
    agent: 'codex',
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true,
    conversationCommands: ['clear'],
    runConversationCommand
  })
  expect(outcome).toEqual({ handled: true, accepted: true, error: null })
  expect(runConversationCommand).toHaveBeenCalledWith('clear', undefined, undefined)
})
