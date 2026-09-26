// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
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
  readStructuredAgentSessionConversationOutline,
  subscribeStructuredAgentSession,
  supportsStructuredAgentSessionPromptCancel
} from './structured-agent-session-client'

describe('structured prompt cancellation capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readLocalCapabilities.mockReturnValue(null)
    mocks.ensureLocalCapabilities.mockResolvedValue(null)
  })

  it('uses the local status cache and fails closed until the host answers', async () => {
    const target = { kind: 'local' } as const
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(false)
    mocks.ensureLocalCapabilities.mockResolvedValue([
      AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY
    ])
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(true)
    mocks.readLocalCapabilities.mockReturnValue([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(true)
    expect(mocks.ensureLocalCapabilities).toHaveBeenCalledTimes(2)
  })

  it('checks the selected remote runtime and downgrades on absent or failed capability', async () => {
    const target = { kind: 'environment', environmentId: 'ssh-env-1' } as const
    mocks.supportsCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(true)
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(false)
    mocks.supportsCapability.mockRejectedValue(new Error('Disconnected'))
    await expect(supportsStructuredAgentSessionPromptCancel(target)).resolves.toBe(false)
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'ssh-env-1',
      AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY
    )
  })
})

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

  it('dispatches rewind once the host advertises the method', async () => {
    await expect(
      callStructuredAgentSession(target, 'agentSession.rewind', params)
    ).resolves.toEqual({
      ok: true
    })
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    )
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(target, 'agentSession.rewind', params)
  })

  it('does not dispatch rewind when host capability cannot be verified', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('Host unreachable'))

    await expect(callStructuredAgentSession(target, 'agentSession.rewind', params)).rejects.toThrow(
      'Host unreachable'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('uses the local build directly and leaves existing remote methods available', async () => {
    await callStructuredAgentSession({ kind: 'local' }, 'agentSession.rewind', params)
    await callStructuredAgentSession(target, 'agentSession.send', params)

    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.rewind', params)
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.send', params)
  })
})

describe('subscribeStructuredAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
    Object.assign(window, {
      api: {
        runtimeEnvironments: { subscribe: mocks.subscribe }
      }
    })
  })

  it('forwards graceful remote closes to the reconnect owner', async () => {
    const onClose = vi.fn()

    await subscribeStructuredAgentSession(
      { kind: 'environment', environmentId: 'env-1' },
      { sessionId: 'session-1' },
      vi.fn(),
      vi.fn(),
      onClose
    )

    const callbacks = mocks.subscribe.mock.calls[0]?.[1] as { onClose?: () => void }
    expect(callbacks.onClose).toBe(onClose)
    callbacks.onClose?.()
    expect(onClose).toHaveBeenCalledOnce()
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
