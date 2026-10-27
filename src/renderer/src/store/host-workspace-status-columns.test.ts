import { describe, expect, it } from 'vitest'
import { getWorkspaceStatus } from '../../../shared/workspace-statuses'
import { makeWorktree } from './slices/worktrees-slice-test-fixtures'
import {
  isWorkspaceStatusAllowedOnHost,
  selectWorkspaceBoardStatuses,
  selectWorkspaceStatusesForHost
} from './host-workspace-status-columns'

const local = [{ id: 'todo', label: 'Todo' }]
const hostWorkspaceStatuses = {
  'env-1': [
    { id: 'in-progress', label: 'Host in progress' },
    { id: 'status-6', label: 'Today' },
    { id: 'status-7', label: 'Unused' }
  ]
}

function card(id: string, workspaceStatus: string, hostId?: 'runtime:env-1') {
  return makeWorktree({ id, repoId: 'repo', hostId, workspaceStatus })
}

describe('selectWorkspaceBoardStatuses', () => {
  it("adds a host's column only when that host's own card sits in it", () => {
    const lanes = selectWorkspaceBoardStatuses({
      workspaceStatuses: local,
      hostWorkspaceStatuses,
      worktreesByRepo: {
        repo: [card('host', 'status-6', 'runtime:env-1'), card('local', 'status-7')]
      },
      folderWorkspaces: []
    })

    expect(lanes.map((status) => status.id)).toEqual(['todo', 'status-6'])
  })

  it("adds a host's column for its SSH workspace, which the host's runtime owns", () => {
    const sshCard = makeWorktree({
      id: 'ssh',
      repoId: 'repo',
      hostId: 'ssh:builder',
      runtimeOwnerEnvironmentId: 'env-1',
      workspaceStatus: 'status-6'
    })
    const lanes = selectWorkspaceBoardStatuses({
      workspaceStatuses: local,
      hostWorkspaceStatuses,
      worktreesByRepo: { repo: [sshCard] },
      folderWorkspaces: []
    })

    expect(lanes.map((status) => status.id)).toEqual(['todo', 'status-6'])
  })

  it("keeps a local card's fallback on the local list when a host card is in the host's default column", () => {
    const unassigned = makeWorktree({ id: 'local', repoId: 'repo' })
    const lanes = selectWorkspaceBoardStatuses({
      workspaceStatuses: local,
      hostWorkspaceStatuses,
      worktreesByRepo: { repo: [card('host', 'in-progress', 'runtime:env-1'), unassigned] },
      folderWorkspaces: []
    })

    expect(getWorkspaceStatus(unassigned, lanes)).toBe('todo')
  })
})

describe('isWorkspaceStatusAllowedOnHost', () => {
  const state = { workspaceStatuses: local, hostWorkspaceStatuses }

  it("lets a card take local columns and its own host's columns only", () => {
    expect(isWorkspaceStatusAllowedOnHost(state, { hostId: 'runtime:env-1' }, 'status-6')).toBe(
      true
    )
    expect(isWorkspaceStatusAllowedOnHost(state, { hostId: 'local' }, 'status-6')).toBe(false)
    expect(isWorkspaceStatusAllowedOnHost(state, { hostId: 'runtime:env-2' }, 'status-6')).toBe(
      false
    )
    expect(isWorkspaceStatusAllowedOnHost(state, { hostId: 'local' }, 'todo')).toBe(true)
    expect(isWorkspaceStatusAllowedOnHost(state, { hostId: 'local' }, 'legacy-id')).toBe(true)
    // A paired host's SSH workspace keeps its owning runtime's columns.
    expect(
      isWorkspaceStatusAllowedOnHost(
        state,
        { hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'env-1' },
        'status-6'
      )
    ).toBe(true)
  })
})

describe('selectWorkspaceStatusesForHost', () => {
  it("offers a host card its host's columns but not the host's copy of the default, matching the board", () => {
    const state = { workspaceStatuses: local, hostWorkspaceStatuses }

    expect(
      selectWorkspaceStatusesForHost(state, { hostId: 'runtime:env-1' }).map((status) => status.id)
    ).toEqual(['todo', 'status-6', 'status-7'])
    expect(selectWorkspaceStatusesForHost(state, { hostId: 'local' })).toBe(local)
  })
})
