/** Negotiate reveal against the workspace’s answering host; local build capabilities say nothing about a paired host’s version. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(),
  environmentIdFor: vi.fn()
}))

// The real target resolution is the thing under test; only the transport is stubbed.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

vi.mock('./worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.environmentIdFor
}))

import {
  activateAiVaultStructuredSession,
  revealStructuredSession
} from './activate-ai-vault-structured-session'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'

const target = { worktreeId: 'workspace-1', sessionId: 'session-1' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({
    ok: true,
    sessionId: target.sessionId,
    workspaceId: target.worktreeId,
    agent: 'codex'
  })
  mocks.supports.mockResolvedValue(true)
  mocks.environmentIdFor.mockReturnValue(null)
})

describe('revealStructuredSession', () => {
  it('asks a local host without a capability round trip', async () => {
    // The local host shares this build; probing it would only add a round trip.
    await expect(revealStructuredSession(target)).resolves.toEqual({ ...target, agent: 'codex' })

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

    await expect(revealStructuredSession(target)).resolves.toEqual({ ...target, agent: 'codex' })

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

  it('keeps a known recipient target when the active workspace would resolve locally', async () => {
    const host = { kind: 'environment', environmentId: 'recipient-host' } as const
    await expect(revealStructuredSession({ ...target, target: host })).resolves.toEqual({
      ...target,
      agent: 'codex'
    })
    expect(mocks.supports).toHaveBeenCalledWith(
      'recipient-host',
      STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
      expect.any(Number)
    )
    expect(mocks.call).toHaveBeenCalledWith(
      host,
      'agentSession.reveal',
      { sessionId: 'session-1' },
      expect.any(Object)
    )
  })

  it('reports a paired host that cannot open it rather than sending an unknown method', async () => {
    // An old host’s method_not_found must request an update rather than claim the chat is gone.
    mocks.environmentIdFor.mockReturnValue('legacy-env')
    mocks.supports.mockResolvedValue(false)

    await expect(revealStructuredSession(target)).resolves.toBe('host-cannot-open')

    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('reads a version block as a host too old, not as a lost connection', async () => {
    mocks.environmentIdFor.mockReturnValue('env-1')
    const blocked = Object.assign(new Error('Update the Orca server'), {
      code: RUNTIME_COMPAT_BLOCK_CODE
    })
    mocks.supports.mockRejectedValue(blocked)

    await expect(revealStructuredSession(target)).resolves.toBe('host-cannot-open')
    expect(mocks.call).not.toHaveBeenCalled()
  })
})

it('returns the actual revealed identity/workspace/provider for reconciliation', async () => {
  mocks.call.mockResolvedValue({
    ok: true,
    sessionId: 'successor',
    workspaceId: 'actual-owner',
    agent: 'claude'
  })
  expect(await revealStructuredSession(target)).toEqual({
    sessionId: 'successor',
    worktreeId: 'actual-owner',
    agent: 'claude'
  })
})

it('bounds a cached stalled probe, releases the shared click and permits a subsequent explicit retry', async () => {
  vi.useFakeTimers()
  const host = { kind: 'environment', environmentId: 'cached-stalled' } as const
  const cached = new Promise<boolean>(() => {})
  mocks.supports.mockReturnValue(cached)
  mocks.call.mockImplementation(async () => ({
    location: { kind: 'chat', sessionId: target.sessionId, worktreeId: target.worktreeId }
  }))
  const parts = {
    tabs: () => [],
    activate: vi.fn(() => false),
    refresh: vi.fn(async () => undefined),
    reveal: revealStructuredSession,
    unavailable: vi.fn(),
    gone: vi.fn(),
    hostCannotOpen: vi.fn()
  }
  const session = {
    structuredSession: { workspaceId: target.worktreeId, sessionId: target.sessionId }
  }
  try {
    const click = activateAiVaultStructuredSession(session, parts, host)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await click).toBe(false)
    expect(parts.unavailable).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'orchestration.partyLocation'
    ])
    mocks.supports.mockResolvedValue(false)
    expect(await activateAiVaultStructuredSession(session, parts, host)).toBe(false)
    expect(parts.hostCannotOpen).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
