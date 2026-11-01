// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  call: vi.fn(),
  supportsCapability: vi.fn(),
  readLocalCapabilities: vi.fn(),
  ensureLocalCapabilities: vi.fn()
}))

vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 7
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('./local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalCapabilities,
  ensureLocalRuntimeCapabilities: mocks.ensureLocalCapabilities
}))

import {
  callStructuredAgentSession,
  readStructuredAgentSessionConversationOutline
} from './structured-agent-session-client'

describe('callStructuredAgentSession rewind capability', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const
  const params = { itemId: 'item-1', expectedEpoch: 'epoch-1' }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.call.mockResolvedValue({ ok: true })
    mocks.supportsCapability.mockResolvedValue(true)
  })

  it('refuses an older host before dispatching rewind', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(callStructuredAgentSession(target, 'agentSession.rewind', params)).rejects.toThrow(
      'Rewinding requires a newer Orca server'
    )
    expect(mocks.supportsCapability).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('does not dispatch rewind when host capability cannot be verified', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('Host unreachable'))

    await expect(callStructuredAgentSession(target, 'agentSession.rewind', params)).rejects.toThrow(
      'Host unreachable'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

describe('callStructuredAgentSession timeouts', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.call.mockResolvedValue({ origin: 'unknown' })
  })

  it('allows restart dispatch settlement while preserving dispatch options', async () => {
    const params = { sessionIds: ['a'] }
    const options = { skipCompatibilityCheck: true as const, beforeSend: vi.fn() }
    await callStructuredAgentSession(target, 'agentSession.restartContinue', params, options)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      target,
      'agentSession.restartContinue',
      params,
      {
        timeoutMs: 600_000,
        ...options
      }
    )
  })
})

describe('conversation outline read', () => {
  const outline = {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: 9 },
    entries: [],
    omittedEntries: 0
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('never calls a host that does not advertise the outline', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    const target = { kind: 'environment', environmentId: 'env-old' } as const
    await expect(readStructuredAgentSessionConversationOutline(target, 'session-1')).resolves.toBe(
      null
    )
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-old',
      AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('reads it from a capable host and lets a failed read reject for a retry', async () => {
    mocks.readLocalCapabilities.mockReturnValue([
      AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY
    ])
    mocks.call.mockResolvedValueOnce(outline)
    const target = { kind: 'local' } as const
    await expect(readStructuredAgentSessionConversationOutline(target, 'session-1')).resolves.toBe(
      outline
    )
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.conversationOutline', {
      sessionId: 'session-1'
    })
    mocks.call.mockRejectedValueOnce(new Error('structured_agent_session_not_attached'))
    await expect(
      readStructuredAgentSessionConversationOutline(target, 'session-1')
    ).rejects.toThrow('structured_agent_session_not_attached')
  })
})
