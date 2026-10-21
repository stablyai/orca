import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { withWorkspaceSpaceVisitActivity } from './workspace-space-visit-activity'
import { sortWorkspaceSpaceRows } from './workspace-space-presentation'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

function row(name: string, lastActivityAt: number): WorkspaceSpaceWorktree {
  return {
    worktreeId: `repo::/${name}`,
    repoId: 'repo',
    executionHostId: 'ssh:box',
    repoDisplayName: 'Repo',
    repoPath: '/repo',
    displayName: name,
    path: `/${name}`,
    branch: name,
    isMainWorktree: false,
    isRemote: true,
    isSparse: false,
    canDelete: true,
    lastActivityAt,
    status: 'ok',
    error: null,
    scannedAt: 0,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

describe('Workspace Space "Last active" with the switch on', () => {
  it('shows and sorts a plain-shell workspace by its visit', () => {
    const shells = row('shells', 10)
    const agent = row('agent', 500)
    const rows = withWorkspaceSpaceVisitActivity([shells, agent], {
      [composeWorktreeHostIdentity('ssh:box', 'repo::/shells')]: 900
    })
    expect(rows[0]?.lastActivityAt).toBe(900)
    expect(rows[1]).toBe(agent)
    expect(sortWorkspaceSpaceRows(rows, 'activity', 'desc').map((r) => r.displayName)).toEqual([
      'shells',
      'agent'
    ])
  })
})
