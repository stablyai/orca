import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from '../../lib/workspace/ownership/worktree-runtime-owner-state'
import { agentUpdatesOwnerKey } from './agent-update-owner'

function stateWithActiveRow(hostId: ExecutionHostId | undefined): WorktreeRuntimeOwnerState {
  return {
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', hostId }] },
    activeWorktreeId: 'repo-1::/w'
  }
}

describe('agentUpdatesOwnerKey', () => {
  it('shows this machine when no workspace is focused', () => {
    expect(agentUpdatesOwnerKey({ activeWorktreeId: null })).toBe('')
  })

  it('shows this machine for a local workspace', () => {
    expect(agentUpdatesOwnerKey(stateWithActiveRow(undefined))).toBe('')
  })

  it("shows the server's machine for a server-owned workspace", () => {
    expect(agentUpdatesOwnerKey(stateWithActiveRow('runtime:env-1'))).toBe('env-1')
  })

  it('hides agent updates for a direct SSH workspace', () => {
    expect(agentUpdatesOwnerKey(stateWithActiveRow('ssh:box'))).toBeNull()
  })

  it('hides agent updates while the focused workspace has no known owner', () => {
    expect(agentUpdatesOwnerKey({ activeWorktreeId: 'missing::/w' })).toBeNull()
  })
})
