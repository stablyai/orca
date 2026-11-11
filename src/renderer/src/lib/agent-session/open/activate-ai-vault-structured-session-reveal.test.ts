/** Negotiate reveal against the workspace’s answering host; local build capabilities say nothing about a paired host’s version. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import './activate-ai-vault-structured-session'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { revealStructuredSession } from './open-existing-structured-session'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(),
  environmentIdFor: vi.fn()
}))

// The real target resolution is the thing under test; only the transport is stubbed.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

vi.mock('../../workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.environmentIdFor
}))

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
  it('reports a paired host that cannot open it rather than sending an unknown method', async () => {
    // An old host’s method_not_found must request an update rather than claim the chat is gone.
    mocks.environmentIdFor.mockReturnValue('legacy-env')
    mocks.supports.mockResolvedValue(false)

    await expect(revealStructuredSession(target)).resolves.toBe('host-cannot-open')

    expect(mocks.call).not.toHaveBeenCalled()
  })
})
