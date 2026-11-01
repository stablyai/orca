import { expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/qualified-worktree-execution-owner'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { getConnectionIdForWorktreeCopy } from '@/lib/connection-owner-resolution'
import { resolveEditorExternalWatchTargetRows } from './editor-external-watch-target-rows'
import { useAppStore } from '@/store'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import type { AppState } from '@/store/types'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'

type SelectedHostState = EditorExternalWatchTargetState &
  Pick<AppState, 'activeWorkspaceExecutionHostId'>

it('retains the inherited folder root through subscription, events and reconnect catch-up in both orders', async () => {
  for (const reverse of [false, true]) {
    const rows = [
      makeFolderWorkspace({ id: 'same-folder', folderPath: '/local', executionHostId: 'local' }),
      makeFolderWorkspace({ id: 'same-folder', folderPath: '/remote', projectGroupId: 'inherited' })
    ]
    const state: SelectedHostState = {
      ...makeState('folder'),
      activeWorkspaceExecutionHostId: 'runtime:owner-a',
      folderWorkspaces: reverse ? rows.toReversed() : rows,
      projectGroups: [
        {
          ...makeProjectGroup(),
          id: 'inherited',
          executionHostId: 'runtime:owner-a',
          connectionId: 'box'
        }
      ]
    }
    const callbacks: { onResponse: (response: unknown) => void }[] = []
    const subscribe = vi.fn(async (_request, listener) => {
      callbacks.push(listener)
      return { unsubscribe: vi.fn() }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe,
          call: vi.fn(async () => ({
            id: 'unwatch',
            ok: true,
            result: {},
            _meta: { runtimeId: 'test' }
          }))
        }
      }
    })
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    const selected = selectEditorExternalWatchTargets(state).targets[0]
    expect
      .soft(selected)
      .toMatchObject({ runtimeEnvironmentId: 'owner-a', worktreePath: '/remote' })
    const payload = vi.fn()
    const error = vi.fn()
    const stop = subscribeEditorRuntimeFileWatch(
      { ...selected, runtimeEnvironmentId: 'owner-a' },
      payload,
      error
    )
    try {
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
      expect(subscribe.mock.calls[0][0]).toMatchObject({
        selector: 'owner-a',
        method: 'files.watch',
        params: { worktree: 'id:folder:same-folder' }
      })
      callbacks[0].onResponse({
        id: 'event',
        ok: true,
        result: {
          type: 'changed',
          worktree: 'folder:same-folder',
          events: [{ kind: 'update', absolutePath: '/remote/a.txt' }]
        },
        _meta: { runtimeId: 'test' }
      })
      expect.soft(payload).toHaveBeenCalledWith({
        worktreePath: '/remote',
        events: [{ kind: 'update', absolutePath: '/remote/a.txt' }]
      })
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['owner-a', { status: null, checkedAt: 0, hostContactEpoch: 1, connectionGeneration: 1 }]
        ])
      })
      await vi.waitFor(() => expect(payload).toHaveBeenCalledTimes(2))
      expect.soft(payload).toHaveBeenCalledWith({
        worktreePath: '/remote',
        events: [{ kind: 'overflow', absolutePath: '/remote' }],
        resync: true
      })
      expect(error).not.toHaveBeenCalled()
    } finally {
      stop()
      await Promise.resolve()
      vi.unstubAllGlobals()
    }
  }
})

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

it('proves legacy watch hosts before matching and refuses unresolved or ambiguous repo proof', () => {
  const repo: Repo = {
    id: 'repo',
    path: '/remote/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: 'box'
  }
  const state: SelectedHostState = {
    ...makeState('worktree'),
    activeWorkspaceExecutionHostId: 'ssh:box',
    repos: [repo],
    worktreesByRepo: {
      repo: [
        makeWorktree({ id: 'same-worktree', repoId: 'repo', path: repo.path, hostId: undefined })
      ]
    }
  }
  expect(selectEditorExternalWatchTargets(state).targets).toMatchObject([
    { connectionId: 'box', worktreePath: '/remote/repo' }
  ])
  expect(
    selectEditorExternalWatchTargets({ ...state, activeWorkspaceExecutionHostId: 'local' }).targets
  ).toEqual([])
  expect(
    selectEditorExternalWatchTargets({ ...state, repos: [repo, { ...repo, connectionId: null }] })
      .targets
  ).toEqual([])
  expect(getResolvedExecutionHostIdForWorktree(state, 'same-worktree')).toBe('ssh:box')
  expect(getConnectionIdForWorktreeCopy(state, 'same-worktree', 'ssh:box')).toBe('box')
  expect(getConnectionIdForWorktreeCopy(state, 'same-worktree', 'local')).toBeUndefined()
  expect(selectEditorExternalWatchTargets({ ...state, repos: [] }).targets).toEqual([])
  const first = state.worktreesByRepo.repo[0]
  const duplicates = { repo: [first, { ...first, path: '/later-copy' }] }
  expect(
    resolveQualifiedWorktreeExecutionOwner(duplicates, state.repos, 'same-worktree', 'ssh:box')
      ?.worktree
  ).toBe(first)
})

it('keeps each logical watch owner amid shared physical SSH aliases in both catalog orders', () => {
  const repo: Repo = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const aliases: SelectedHostState = {
    ...makeState('worktree'),
    repos: ['hub-a', 'hub-b'].map((id) => ({
      ...repo,
      executionHostId: `runtime:${id}` as const,
      connectionId: null
    })),
    worktreesByRepo: {
      repo: ['hub-a', 'hub-b'].map((runtimeOwnerEnvironmentId) =>
        makeWorktree({
          id: 'same-worktree',
          repoId: 'repo',
          path: `/${runtimeOwnerEnvironmentId}/repo`,
          hostId: 'ssh:private-target',
          runtimeOwnerEnvironmentId
        })
      )
    }
  }
  for (const reverse of [false, true]) {
    const ordered = {
      ...aliases,
      repos: reverse ? aliases.repos.toReversed() : aliases.repos,
      worktreesByRepo: {
        repo: reverse ? aliases.worktreesByRepo.repo.toReversed() : aliases.worktreesByRepo.repo
      }
    }
    for (const id of ['hub-a', 'hub-b'] as const) {
      expect(
        selectEditorExternalWatchTargets({
          ...ordered,
          activeWorktreeId: null,
          rightSidebarOpen: false,
          lastVisitedAtByWorktreeId: { 'same-worktree': 1 },
          openFiles: [
            {
              id: `${id}:file.ts`,
              worktreeId: 'same-worktree',
              filePath: `/${id}/repo/file.ts`,
              relativePath: 'file.ts',
              language: 'typescript',
              mode: 'edit',
              isDirty: false,
              runtimeEnvironmentId: id
            }
          ]
        }).targets
      ).toEqual([
        {
          worktreeId: 'same-worktree',
          worktreePath: `/${id}/repo`,
          runtimeEnvironmentId: id,
          connectionId: undefined
        }
      ])
      const selected = resolveQualifiedWorktreeExecutionOwner(
        ordered.worktreesByRepo,
        ordered.repos,
        'same-worktree',
        `runtime:${id}`
      )
      expect(selected?.hostId).toBe(`runtime:${id}`)
      expect(selected?.worktree.path).toBe(`/${id}/repo`)
      expect(
        getResolvedExecutionHostIdForWorktree(
          { ...ordered, activeWorkspaceExecutionHostId: `runtime:${id}` },
          'same-worktree'
        )
      ).toBe(`runtime:${id}`)
    }
    expect(resolveEditorExternalWatchTargetRows(ordered, 'same-worktree', null)).toBeNull()
    expect(
      resolveEditorExternalWatchTargetRows(ordered, 'same-worktree', 'ssh:private-target')
    ).toBeNull()
  }
})
