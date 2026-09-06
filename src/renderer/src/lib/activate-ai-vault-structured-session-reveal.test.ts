/**
 * The reveal call itself, rather than the activation flow that injects it.
 *
 * What it has to get right is which host it negotiates against: the chat lives on the host that
 * owns the workspace, which for a paired workspace is not this process. Gating on the local build's
 * capabilities would pass unconditionally on desktop and say nothing about the host being called.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(),
  environmentIdFor: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', async () => {
  // The real target resolution is the thing under test; only the transport is stubbed.
  const { getActiveRuntimeTarget } = await import('@/runtime/runtime-client-target')
  return {
    getActiveRuntimeTarget,
    callRuntimeRpc: mocks.call,
    runtimeEnvironmentSupportsCapability: mocks.supports
  }
})

vi.mock('./worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.environmentIdFor
}))

import { revealStructuredSession } from './activate-ai-vault-structured-session'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const target = { worktreeId: 'workspace-1', sessionId: 'session-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ ok: true })
  mocks.supports.mockResolvedValue(true)
  mocks.environmentIdFor.mockReturnValue(null)
})

describe('revealStructuredSession', () => {
  it('asks a local host without a capability round trip', async () => {
    // The renderer and its local host are one build, so probing would only cost a round trip on a
    // user's click to prove something already known.
    await expect(revealStructuredSession(target)).resolves.toBe('revealed')

    expect(mocks.supports).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.reveal',
      { sessionId: 'session-1' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('negotiates against the host that owns the workspace, not the local one', async () => {
    mocks.environmentIdFor.mockReturnValue('env-1')

    await expect(revealStructuredSession(target)).resolves.toBe('revealed')

    expect(mocks.supports).toHaveBeenCalledWith(
      'env-1',
      STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
      expect.any(Number)
    )
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'agentSession.reveal',
      { sessionId: 'session-1' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('reports a paired host that cannot open it rather than sending an unknown method', async () => {
    // The regression this guards: an older paired host answers method_not_found, which is
    // indistinguishable from a refusal, so the user is told the chat is gone when it is not.
    mocks.environmentIdFor.mockReturnValue('legacy-env')
    mocks.supports.mockResolvedValue(false)

    await expect(revealStructuredSession(target)).resolves.toBe('host-cannot-open')

    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('reports unreachable when the capability probe cannot reach the host', async () => {
    // Losing contact is not evidence about the host's age or about the chat.
    mocks.environmentIdFor.mockReturnValue('env-1')
    mocks.supports.mockRejectedValue(new Error('status timeout'))

    await expect(revealStructuredSession(target)).resolves.toBe('unreachable')

    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('reports the chat gone only when the host itself refused', async () => {
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_identity_required' }
    })

    await expect(revealStructuredSession(target)).resolves.toBe('gone')
  })

  it('reports unreachable when the call fails rather than answers', async () => {
    mocks.call.mockRejectedValue(new Error('structured_session_restore_timeout'))

    await expect(revealStructuredSession(target)).resolves.toBe('unreachable')
  })
})
