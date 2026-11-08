import { expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { AppState } from '@/store/types'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getDefaultSettings } from '../../../shared/constants'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'

type SelectedHostState = EditorExternalWatchTargetState &
  Pick<AppState, 'activeWorkspaceExecutionHostId'>

const hosts = ['host-a', 'host-b'] as const
function makeState(
  workspace: 'worktree' | 'folder',
  rootFor: (host: string) => string = () => (workspace === 'folder' ? '/folder' : '/repo')
): SelectedHostState {
  const id = workspace === 'folder' ? 'folder:same-folder' : 'same-worktree'
  return {
    settings: getDefaultSettings('/home/me'),
    openFiles: [],
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'runtime:host-a',
    repos: [],
    worktreesByRepo:
      workspace === 'worktree'
        ? {
            repo: hosts.map((host) =>
              makeWorktree({ id, repoId: 'repo', path: rootFor(host), hostId: `runtime:${host}` })
            )
          }
        : {},
    folderWorkspaces:
      workspace === 'folder'
        ? hosts.map((host) =>
            makeFolderWorkspace({
              id: 'same-folder',
              folderPath: rootFor(host),
              executionHostId: `runtime:${host}`
            })
          )
        : [],
    projectGroups: [],
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map()
  }
}

it('keeps an open local editor watched locally when a same-id direct-SSH folder is selected', () => {
  const localFile = {
    id: 'local:a.txt',
    filePath: '/local/notes/a.txt',
    relativePath: 'a.txt',
    worktreeId: 'folder:notes',
    language: 'plaintext',
    isDirty: false,
    mode: 'edit' as const,
    runtimeEnvironmentId: null,
    operationProvenance: {
      generation: {
        route: { executionHostId: 'local' as const, runtimeEnvironmentId: null },
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      },
      ownershipProjection: 'explicit' as const
    }
  }
  const state: SelectedHostState = {
    ...makeState('folder'),
    activeWorktreeId: 'folder:notes',
    activeWorkspaceExecutionHostId: 'ssh:ssh-a',
    openFiles: [localFile],
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'notes', folderPath: '/local/notes', executionHostId: 'local' }),
      makeFolderWorkspace({
        id: 'notes',
        folderPath: '/remote/notes',
        executionHostId: 'ssh:ssh-a'
      })
    ]
  }
  const watched = (next: SelectedHostState): [string, string | undefined][] =>
    selectEditorExternalWatchTargets(next).targets.map((target) => [
      target.worktreePath,
      target.connectionId
    ])

  expect(watched({ ...state, rightSidebarOpen: false })).toEqual([['/local/notes', undefined]])
  expect(watched(state)).toEqual([
    ['/local/notes', undefined],
    ['/remote/notes', 'ssh-a']
  ])
})

it('never watches a sibling repo host when the requested worktree owner is absent or unstamped', () => {
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const state: SelectedHostState = {
    ...makeState('worktree'),
    activeWorkspaceExecutionHostId: 'local',
    repos: [repo, { ...repo, connectionId: 'builder' }],
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'same-worktree', repoId: 'repo', hostId: undefined })]
    }
  }
  expect(selectEditorExternalWatchTargets(state).targets).toEqual([])
  const captured = {
    ...state,
    worktreesByRepo: {
      repo: [
        makeWorktree({ id: 'same-worktree', repoId: 'repo', path: '/repo', hostId: 'ssh:builder' })
      ]
    }
  }
  expect(selectEditorExternalWatchTargets(captured).targets).toEqual([])
  expect(
    selectEditorExternalWatchTargets({ ...captured, activeWorkspaceExecutionHostId: 'ssh:builder' })
      .targets
  ).toMatchObject([{ connectionId: 'builder', worktreePath: '/repo' }])
})
