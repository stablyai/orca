import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { selectWorkspaceWindowMetadata } from './workspace-window-metadata-selector'

type SelectorState = Parameters<typeof selectWorkspaceWindowMetadata>[0]

function createRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    displayName: 'orca',
    path: '/Users/example/statvis-dev/orca',
    badgeColor: '',
    addedAt: 0,
    ...overrides
  }
}

function createState(overrides: Partial<SelectorState> = {}): SelectorState {
  const worktree = {
    displayName: 'stevie-vs-orca',
    repoId: 'repo-1',
    hostId: 'local',
    path: '/Users/example/statvis-dev/worktrees/stevie-vs-orca'
  } satisfies Pick<Worktree, 'displayName' | 'hostId' | 'path' | 'repoId'>
  return {
    activePendingCreationId: null,
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'worktree-1',
    pendingWorktreeCreations: {},
    repos: [createRepo()],
    getKnownWorktreeById: vi.fn(() => worktree),
    ...overrides
  }
}

describe('selectWorkspaceWindowMetadata', () => {
  it('reports the active local Git worktree name, original repository and path', () => {
    expect(selectWorkspaceWindowMetadata(createState())).toEqual({
      displayName: 'stevie-vs-orca',
      repoName: 'orca',
      localPath: '/Users/example/statvis-dev/worktrees/stevie-vs-orca'
    })
  })

  it('uses folder workspace projections through the shared worktree lookup', () => {
    const getKnownWorktreeById = vi.fn(() => ({
      displayName: 'Local notes',
      repoId: 'folder-workspace:notes',
      hostId: 'local' as const,
      path: '/Users/example/notes'
    }))
    expect(
      selectWorkspaceWindowMetadata(
        createState({ activeWorktreeId: 'folder:notes', getKnownWorktreeById })
      )
    ).toEqual({ displayName: 'Local notes', repoName: null, localPath: '/Users/example/notes' })
    expect(getKnownWorktreeById).toHaveBeenCalledWith('folder:notes', 'local')
  })

  it('reports remote workspace names without representing remote paths as local files', () => {
    const sshHostId = toSshExecutionHostId('dev-vps')
    expect(
      selectWorkspaceWindowMetadata(
        createState({
          activeWorkspaceExecutionHostId: sshHostId,
          repos: [
            createRepo(),
            createRepo({ displayName: 'remote-repo', connectionId: 'dev-vps' })
          ],
          getKnownWorktreeById: vi.fn(() => ({
            displayName: 'remote-task',
            repoId: 'repo-1',
            hostId: sshHostId,
            path: '/srv/orca/remote-task'
          }))
        })
      )
    ).toEqual({ displayName: 'remote-task', repoName: 'remote-repo', localPath: null })
  })

  it('uses the paired runtime repository for a nested SSH workspace', () => {
    expect(
      selectWorkspaceWindowMetadata(
        createState({
          activeWorkspaceExecutionHostId: 'ssh:nested-host',
          repos: [
            createRepo(),
            createRepo({ displayName: 'paired-repo', executionHostId: 'runtime:paired-host' })
          ],
          getKnownWorktreeById: vi.fn(() => ({
            displayName: 'remote-task',
            repoId: 'repo-1',
            hostId: 'ssh:nested-host' as const,
            runtimeOwnerEnvironmentId: 'paired-host',
            path: '/srv/orca/remote-task'
          }))
        })
      )
    ).toEqual({ displayName: 'remote-task', repoName: 'paired-repo', localPath: null })
  })

  it('keeps the workspace name when its repository is missing, on another host or a folder', () => {
    for (const repos of [
      [],
      [createRepo({ connectionId: 'other-host' })],
      [createRepo({ kind: 'folder' })]
    ]) {
      expect(selectWorkspaceWindowMetadata(createState({ repos }))).toEqual({
        displayName: 'stevie-vs-orca',
        repoName: null,
        localPath: '/Users/example/statvis-dev/worktrees/stevie-vs-orca'
      })
    }
  })

  it('clears metadata outside an active workspace surface', () => {
    const pendingWorktreeCreations = { creation: {} }
    for (const state of [
      createState({ activeView: 'settings' }),
      createState({ activeWorktreeId: null }),
      createState({ activePendingCreationId: 'creation', pendingWorktreeCreations }),
      createState({ getKnownWorktreeById: vi.fn(() => undefined) })
    ]) {
      expect(selectWorkspaceWindowMetadata(state)).toEqual({
        displayName: null,
        repoName: null,
        localPath: null
      })
    }
  })
})
