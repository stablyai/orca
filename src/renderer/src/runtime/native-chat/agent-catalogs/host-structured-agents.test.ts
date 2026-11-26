import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import {
  loadHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  resetHostStructuredAgentsForTests
} from './host-structured-agents'

vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
beforeEach(() => {
  vi.resetAllMocks()
  resetHostStructuredAgentsForTests()
})
afterEach(resetHostStructuredAgentsForTests)

it('discards a cleared in-flight catalog without overwriting or cancelling its replacement', async () => {
  const oldReply = Promise.withResolvers<unknown>()
  const newReply = Promise.withResolvers<unknown>()
  vi.mocked(callRuntimeRpc)
    .mockReturnValueOnce(oldReply.promise)
    .mockReturnValueOnce(newReply.promise)
  const capabilities = [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY]
  const oldLoad = loadHostStructuredAgents('local', capabilities, null)
  resetHostStructuredAgentsForTests()
  const newLoad = loadHostStructuredAgents('local', capabilities, null)
  oldReply.resolve({ agents: [{ agent: 'codex', capabilities: { currentFork: true } }] })
  await oldLoad
  expect(readHostStructuredAgentsForRuntime('local', null)).toBeUndefined()
  newReply.resolve({ agents: [{ agent: 'claude', capabilities: {} }] })
  await newLoad
  expect(readHostStructuredAgentsForRuntime('local', null)?.map((agent) => agent.agent)).toEqual([
    'claude'
  ])
})
