import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { selectWorkspaceWindowMetadata } from './workspace-window-metadata-selector'

type SelectorState = Parameters<typeof selectWorkspaceWindowMetadata>[0]

function createState(overrides: Partial<SelectorState> = {}): SelectorState {
  const worktree = {
    displayName: 'stevie-vs-orca',
    hostId: 'local',
    path: '/Users/example/statvis-dev/worktrees/stevie-vs-orca'
  } satisfies Pick<Worktree, 'displayName' | 'hostId' | 'path'>
  return {
    activePendingCreationId: null,
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'worktree-1',
    pendingWorktreeCreations: {},
    getKnownWorktreeById: vi.fn(() => worktree),
    ...overrides
  }
}

describe('selectWorkspaceWindowMetadata', () => {
  it('reports the active local Git worktree name and path', () => {
    expect(selectWorkspaceWindowMetadata(createState())).toEqual({
      displayName: 'stevie-vs-orca',
      localPath: '/Users/example/statvis-dev/worktrees/stevie-vs-orca'
    })
  })

  it('uses folder workspace projections through the shared worktree lookup', () => {
    const getKnownWorktreeById = vi.fn(() => ({
      displayName: 'Local notes',
      hostId: 'local' as const,
      path: '/Users/example/notes'
    }))
    expect(
      selectWorkspaceWindowMetadata(
        createState({ activeWorktreeId: 'folder:notes', getKnownWorktreeById })
      )
    ).toEqual({ displayName: 'Local notes', localPath: '/Users/example/notes' })
    expect(getKnownWorktreeById).toHaveBeenCalledWith('folder:notes', 'local')
  })

  it('reports remote workspace names without representing remote paths as local files', () => {
    const sshHostId = toSshExecutionHostId('dev-vps')
    expect(
      selectWorkspaceWindowMetadata(
        createState({
          activeWorkspaceExecutionHostId: sshHostId,
          getKnownWorktreeById: vi.fn(() => ({
            displayName: 'remote-task',
            hostId: sshHostId,
            path: '/srv/orca/remote-task'
          }))
        })
      )
    ).toEqual({ displayName: 'remote-task', localPath: null })
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
        localPath: null
      })
    }
  })
})
