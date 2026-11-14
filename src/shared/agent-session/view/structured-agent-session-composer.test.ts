import { expect, it } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  prepareStructuredAgentSessionComposerCommand
} from './structured-agent-session-composer'

it('routes /new through the host conversation clear instead of sending it to the agent', async () => {
  expect(isStructuredAgentSessionComposerCommand('/new', 'codex', [])).toBe(true)
  expect(prepareStructuredAgentSessionComposerCommand('codex')('/new')).toBe(true)
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
