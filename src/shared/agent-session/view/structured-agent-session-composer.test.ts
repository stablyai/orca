import { expect, it } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  prepareStructuredAgentSessionComposerCommand
} from './structured-agent-session-composer'

it.each(['codex', 'claude'] as const)(
  'routes %s /new through the host conversation clear',
  async (agent) => {
    expect(isStructuredAgentSessionComposerCommand('/new', agent, [])).toBe(true)
    expect(prepareStructuredAgentSessionComposerCommand(agent)('/new')).toBe(true)
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/new', {
        agent,
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear'],
        runConversationCommand: async (command) => ({ accepted: command === 'clear', error: null })
      })
    ).toEqual({ handled: true, accepted: true, error: null })
  }
)

it('leaves OMP /new for the agent instead of clearing its context', async () => {
  expect(isStructuredAgentSessionComposerCommand('/new', 'omp', [])).toBe(false)
  expect(prepareStructuredAgentSessionComposerCommand('omp')('/new')).toBe(false)
  expect(
    await dispatchStructuredAgentSessionComposerCommand('/new', {
      agent: 'omp',
      snapshot: [],
      invokeAction: async () => true,
      setOption: async () => true,
      conversationCommands: ['clear'],
      runConversationCommand: async () => ({ accepted: true, error: null })
    })
  ).toEqual({ handled: false, accepted: false, error: null })
})
