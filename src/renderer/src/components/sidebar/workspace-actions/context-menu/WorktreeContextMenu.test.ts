import { describe, expect, it } from 'vitest'
import {
  getSharedWorkspaceStatus,
  planWorkspaceStatusAssignment
} from './worktree-context-menu-policy'
import { getDeleteStateForWorktreeHost } from '../deletion/worktree-delete-state-host-match'

import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

describe('getDeleteStateForWorktreeHost', () => {
  const local = { id: 'repo::path', hostId: 'local' } as unknown as Worktree
  const ssh = { id: 'repo::path', hostId: 'ssh:box' } as unknown as Worktree
  const sshDelete = {
    isDeleting: true,
    executionHostId: 'ssh:box' as const,
    error: null,
    canForceDelete: false,
    forceDeleteReason: null
  }

  it('keeps host-qualified pending state on its matching row only', () => {
    const states = { [getWorktreeHostIdentity(ssh)]: sshDelete }
    expect(getDeleteStateForWorktreeHost(ssh, states)).toBe(sshDelete)
    expect(getDeleteStateForWorktreeHost(local, states)).toBeUndefined()
  })
})

describe('planWorkspaceStatusAssignment (context-menu "Move to Status" routing)', () => {
  // Board status changes must use Linear sync; sidebar assignments remain local.
  const statuses: WorkspaceStatusDefinition[] = [
    { id: 'todo', label: 'Todo' },
    { id: 'in-review', label: 'In review' }
  ]
  const wt = (id: string, workspaceStatus: string): Worktree =>
    ({ id, workspaceStatus }) as Worktree

  it("compares each card against its own host's columns in a mixed selection", () => {
    const hostColumns: WorkspaceStatusDefinition[] = [
      ...statuses,
      { id: 'status-6', label: 'Today' }
    ]
    const local = wt('a', 'todo')
    const hosted = { ...wt('b', 'status-6'), hostId: 'runtime:env-1' as const }
    const statusesFor = (item: Worktree) => (item.hostId ? hostColumns : statuses)

    expect(getSharedWorkspaceStatus([local, hosted], statusesFor)).toBe('')
    expect(planWorkspaceStatusAssignment([local, hosted], 'todo', statusesFor, false)).toEqual({
      kind: 'local-only',
      localWriteIds: ['b']
    })
  })
})
