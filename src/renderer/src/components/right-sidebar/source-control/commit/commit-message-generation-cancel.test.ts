import { describe, expect, it, vi } from 'vitest'

const cancel = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  cancelRuntimeGenerateCommitMessage: cancel
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => 'ssh-1' }))

import { cancelCommitMessageGenerationRequest } from './commit-message-generation-cancel'

describe('commit message Stop without a request identity', () => {
  it('falls back to the legacy path Stop through the workspace owner', () => {
    cancelCommitMessageGenerationRequest({
      key: 'record-key',
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo',
      ownerTarget: { kind: 'local' },
      record: null,
      inFlight: { 'repo-1::/repo': true },
      intentTokens: {},
      updateRecord: vi.fn()
    })
    expect(cancel).toHaveBeenCalledWith({
      target: { kind: 'local' },
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo',
      connectionId: 'ssh-1'
    })
  })
})
