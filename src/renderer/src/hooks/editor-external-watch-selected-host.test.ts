import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
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

it.each(['worktree', 'folder'] as const)(
  'changes the %s watcher when only the selected execution host changes',
  (workspace) => {
    const state = makeState(workspace)
    const first = selectEditorExternalWatchTargets(state)
    expect(first.targets.map((target) => target.runtimeEnvironmentId)).toEqual(['host-a'])
    const switched = selectEditorExternalWatchTargets({
      ...state,
      activeWorkspaceExecutionHostId: 'runtime:host-b'
    })
    expect(switched.targets.map((target) => target.runtimeEnvironmentId)).toEqual(['host-b'])
    expect(switched.targetsKey).not.toBe(first.targetsKey)
    expect(selectEditorExternalWatchTargets(state).targetsKey).toBe(first.targetsKey)
  }
)

it.each(['worktree', 'folder'] as const)(
  'preserves the %s watcher snapshot when selection and watched roots stay unchanged',
  (workspace) => {
    const state = makeState(workspace)
    const first = selectEditorExternalWatchTargets(state)
    expect(selectEditorExternalWatchTargets({ ...state })).toBe(first)
  }
)

it.each(['worktree', 'folder'] as const)(
  "watches the selected host's %s root when hosts publish the same id at different roots",
  (workspace) => {
    const state = makeState(workspace, (host) => `/${host}/repo`)
    const onB = selectEditorExternalWatchTargets({
      ...state,
      activeWorkspaceExecutionHostId: 'runtime:host-b'
    })
    expect(onB.targets.map((target) => [target.runtimeEnvironmentId, target.worktreePath])).toEqual(
      [['host-b', '/host-b/repo']]
    )
    const onA = selectEditorExternalWatchTargets(state)
    expect(onA.targets.map((target) => [target.runtimeEnvironmentId, target.worktreePath])).toEqual(
      [['host-a', '/host-a/repo']]
    )
  }
)

it('watches each open file owner at its own host root', () => {
  const state = makeState('worktree', (host) => `/${host}/repo`)
  const { targets } = selectEditorExternalWatchTargets({
    ...state,
    rightSidebarOpen: false,
    openFiles: (['host-a', 'host-b'] as const).map((host) => ({
      id: `${host}:a.ts`,
      filePath: `/${host}/repo/a.ts`,
      relativePath: 'a.ts',
      worktreeId: 'same-worktree',
      language: 'typescript',
      isDirty: false,
      mode: 'edit' as const,
      runtimeEnvironmentId: host
    }))
  })
  expect(targets.map((target) => [target.runtimeEnvironmentId, target.worktreePath])).toEqual([
    ['host-a', '/host-a/repo'],
    ['host-b', '/host-b/repo']
  ])
})

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
