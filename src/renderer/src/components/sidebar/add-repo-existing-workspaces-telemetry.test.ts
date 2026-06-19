import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  buildAddRepoExistingWorkspacesTelemetry,
  shouldTrackAddRepoExistingWorkspacesDetected
} from './add-repo-existing-workspaces-telemetry'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo::/repo',
    repoId: 'repo',
    path: '/repo',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('add repo existing workspace telemetry', () => {
  it('builds count-only payloads without raw workspace names', () => {
    const payload = buildAddRepoExistingWorkspacesTelemetry('local_folder_picker', [
      worktree({ path: '/repo', displayName: 'main', branch: 'refs/heads/main' }),
      worktree({
        id: 'repo::/repo-feature',
        path: '/repo-feature',
        displayName: 'Feature With User Text',
        branch: 'refs/heads/feature/private-task',
        isMainWorktree: false,
        isSparse: true
      }),
      worktree({
        id: 'repo::/detached',
        path: 'C:\\workspaces\\detached',
        displayName: 'detached',
        branch: '',
        isMainWorktree: false
      })
    ])

    expect(payload).toEqual({
      source: 'local_folder_picker',
      existing_workspace_count: 3,
      existing_linked_workspace_count: 2,
      main_workspace_count: 1,
      branch_named_workspace_count: 2,
      detached_workspace_count: 1,
      custom_named_workspace_count: 1,
      sparse_workspace_count: 1
    })
    expect(JSON.stringify(payload)).not.toContain('private-task')
    expect(JSON.stringify(payload)).not.toContain('Feature With User Text')
  })

  it('tracks detection only for imported linked workspaces', () => {
    expect(buildAddRepoExistingWorkspacesTelemetry(null, [worktree({})])).toBeNull()
    expect(buildAddRepoExistingWorkspacesTelemetry('local_folder_picker', [])).toBeNull()

    const mainOnlyPayload = buildAddRepoExistingWorkspacesTelemetry('local_folder_picker', [
      worktree({})
    ])
    expect(mainOnlyPayload?.existing_linked_workspace_count).toBe(0)
    expect(shouldTrackAddRepoExistingWorkspacesDetected(mainOnlyPayload)).toBe(false)

    const importedLocalPayload = buildAddRepoExistingWorkspacesTelemetry('local_folder_picker', [
      worktree({}),
      worktree({ id: 'repo::/repo-existing', path: '/repo-existing', isMainWorktree: false })
    ])
    const importedRemotePayload = buildAddRepoExistingWorkspacesTelemetry('ssh_remote_path', [
      worktree({}),
      worktree({ id: 'repo::/remote-existing', path: '/remote-existing', isMainWorktree: false })
    ])
    const clonePayload = buildAddRepoExistingWorkspacesTelemetry('clone_url', [
      worktree({}),
      worktree({ id: 'repo::/clone-existing', path: '/clone-existing', isMainWorktree: false })
    ])
    const createPayload = buildAddRepoExistingWorkspacesTelemetry('create_project', [
      worktree({}),
      worktree({ id: 'repo::/create-existing', path: '/create-existing', isMainWorktree: false })
    ])

    expect(shouldTrackAddRepoExistingWorkspacesDetected(importedLocalPayload)).toBe(true)
    expect(shouldTrackAddRepoExistingWorkspacesDetected(importedRemotePayload)).toBe(true)
    expect(shouldTrackAddRepoExistingWorkspacesDetected(clonePayload)).toBe(false)
    expect(shouldTrackAddRepoExistingWorkspacesDetected(createPayload)).toBe(false)
  })

  it('derives linked and detached counts before clamping reported values', () => {
    const mainOnlyPayload = buildAddRepoExistingWorkspacesTelemetry(
      'local_folder_picker',
      Array.from({ length: 60 }, (_, index) =>
        worktree({
          id: `repo::/repo-main-${index}`,
          path: `/repo-main-${index}`,
          isMainWorktree: true
        })
      )
    )

    expect(mainOnlyPayload).toMatchObject({
      existing_workspace_count: 50,
      existing_linked_workspace_count: 0,
      main_workspace_count: 50,
      detached_workspace_count: 0
    })
    expect(shouldTrackAddRepoExistingWorkspacesDetected(mainOnlyPayload)).toBe(false)
  })
})
