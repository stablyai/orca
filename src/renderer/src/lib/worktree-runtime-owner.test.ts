import { describe, expect, it } from 'vitest'
import '../../../shared/constants'
import {
  getExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from './worktree-runtime-owner'
import './terminal-worktree-route'
import './runtime-session-mirror-owners'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { runtimeEnvironmentIdForWorkspaceOwner } from './resolve-owner'
/** The owner's paired server, as production callers read it; null for this app or a twin. */
function ownerEnvironmentId(
  state: Parameters<typeof runtimeEnvironmentIdForWorkspaceOwner>[0],
  workspaceId: string
): string | null {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  return owner.kind === 'resolved' ? owner.environmentId : null
}

describe('runtime owner identity indexes', () => {
  it('indexes immutable owner records once across repeated worktree and folder lookups', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    let folderWorkspaceIdReads = 0
    let projectGroupIdReads = 0
    const targetWorktreeId = 'worktree-99-99'
    const targetRepoId = 'repo-99'
    const targetFolderWorkspaceId = 'folder-workspace-999'
    const targetProjectGroupId = 'project-group-999'
    const repos: NonNullable<WorktreeRuntimeOwnerState['repos']>[number][] = []
    const worktreesByRepo: NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']> = {}
    const folderWorkspaces: NonNullable<WorktreeRuntimeOwnerState['folderWorkspaces']>[number][] =
      []
    const projectGroups: NonNullable<WorktreeRuntimeOwnerState['projectGroups']>[number][] = []

    for (let repoIndex = 0; repoIndex < 100; repoIndex += 1) {
      const repoId = `repo-${repoIndex}`
      const repo: NonNullable<WorktreeRuntimeOwnerState['repos']>[number] = {
        id: repoId,
        connectionId: null,
        executionHostId: repoId === targetRepoId ? 'runtime:repo-owner' : 'local'
      }
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => {
          repoIdReads += 1
          return repoId
        }
      })
      repos.push(repo)
      worktreesByRepo[repoId] = Array.from({ length: 100 }, (_, worktreeIndex) => {
        const worktreeId = `worktree-${repoIndex}-${worktreeIndex}`
        const worktree = { id: worktreeId, repoId }
        Object.defineProperty(worktree, 'id', {
          enumerable: true,
          get: () => {
            worktreeIdReads += 1
            return worktreeId
          }
        })
        return worktree
      })
    }
    for (let index = 0; index < 1_000; index += 1) {
      const folderWorkspaceId = `folder-workspace-${index}`
      const projectGroupId = `project-group-${index}`
      const folderWorkspace = { id: folderWorkspaceId, projectGroupId }
      const projectGroup: NonNullable<WorktreeRuntimeOwnerState['projectGroups']>[number] = {
        id: projectGroupId,
        connectionId: null,
        executionHostId: projectGroupId === targetProjectGroupId ? 'runtime:folder-owner' : 'local'
      }
      Object.defineProperty(folderWorkspace, 'id', {
        enumerable: true,
        get: () => {
          folderWorkspaceIdReads += 1
          return folderWorkspaceId
        }
      })
      Object.defineProperty(projectGroup, 'id', {
        enumerable: true,
        get: () => {
          projectGroupIdReads += 1
          return projectGroupId
        }
      })
      folderWorkspaces.push(folderWorkspace)
      projectGroups.push(projectGroup)
    }
    const indexedState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: null },
      repos,
      worktreesByRepo,
      folderWorkspaces,
      projectGroups
    }

    let warmedFolderReads = 0
    let warmedGroupReads = 0
    for (let lookup = 0; lookup < 200; lookup += 1) {
      runtimeEnvironmentIdOrLocalUnlessTwin(indexedState, targetWorktreeId)
      ownerEnvironmentId(indexedState, targetWorktreeId)
      getExecutionHostIdForWorktree(indexedState, targetWorktreeId)
      runtimeEnvironmentIdOrLocalUnlessTwin(indexedState, `folder:${targetFolderWorkspaceId}`)
      ownerEnvironmentId(indexedState, `folder:${targetFolderWorkspaceId}`)
      getExecutionHostIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)
      if (lookup === 0) {
        warmedFolderReads = folderWorkspaceIdReads
        warmedGroupReads = projectGroupIdReads
      }
    }

    expect(worktreeIdReads).toBe(10_000)
    // One build each for the owner index and the operation-route index, then no rescans.
    expect(repoIdReads).toBe(200)
    expect(folderWorkspaceIdReads).toBe(warmedFolderReads)
    expect(projectGroupIdReads).toBe(warmedGroupReads)
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(indexedState, targetWorktreeId)).toBe('repo-owner')
    expect(getExecutionHostIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)).toBe(
      'runtime:folder-owner'
    )
  })

  it('rebuilds owner indexes when immutable collection references change', () => {
    const first: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-one' }],
      worktreesByRepo: { repo: [{ id: 'worktree', repoId: 'repo' }] },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-one' }]
    }
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(first, 'worktree')).toBe('repo-one')
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(first, 'folder:folder')).toBe('folder-one')

    const second: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-two' }],
      worktreesByRepo: {
        repo: [{ id: 'worktree', repoId: 'repo', hostId: 'runtime:worktree-two' }]
      },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-two' }]
    }
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(second, 'worktree')).toBe('worktree-two')
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(second, 'folder:folder')).toBe('folder-two')
  })
})
