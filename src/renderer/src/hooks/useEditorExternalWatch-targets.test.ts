import { describe, expect, it, vi } from 'vitest'
import {
  getEditorExternalWatchTargets,
  sharesLocalWatchRoot,
  type EditorExternalWatchTargetState
} from './useEditorExternalWatch'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
vi.mock('@/components/editor/editor-autosave', () => ({
  notifyEditorExternalFileChange: vi.fn(),
  getOpenFilesForExternalFileChange: vi.fn(() => [])
}))

describe('getEditorExternalWatchTargets', () => {
  // Why: the memo guard compares identities, so shared defaults must be stable across calls or every guard conjunct is untestable.
  const EMPTY_GIT_STATUS_HUGE: EditorExternalWatchTargetState['gitStatusHugeByWorktree'] = {}
  const EMPTY_SSH_STATES: EditorExternalWatchTargetState['sshConnectionStates'] = new Map()
  const EMPTY_RESTORED_HOST_IDS: EditorExternalWatchTargetState['restoredRuntimeHostIdByWorkspaceSessionKey'] =
    {}
  const EMPTY_RUNTIME_ENVS: EditorExternalWatchTargetState['runtimeEnvironments'] = []

  const makeRepo = (
    id: string,
    connectionId: string | null = null,
    executionHostId?: EditorExternalWatchTargetState['repos'][number]['executionHostId']
  ): EditorExternalWatchTargetState['repos'][number] =>
    ({
      id,
      path: `/${id}`,
      kind: 'git',
      connectionId,
      executionHostId
    }) as EditorExternalWatchTargetState['repos'][number]

  const makeWorktree = (
    repoId: string,
    id = `${repoId}-wt`
  ): EditorExternalWatchTargetState['worktreesByRepo'][string][number] =>
    ({
      id,
      repoId,
      path: `/${repoId}/worktree`
    }) as EditorExternalWatchTargetState['worktreesByRepo'][string][number]

  const makeOpenFile = (
    worktreeId: string,
    isDirty = false
  ): EditorExternalWatchTargetState['openFiles'][number] =>
    ({
      id: `${worktreeId}-file`,
      worktreeId,
      filePath: `/repo/${worktreeId}/notes.md`,
      relativePath: 'notes.md',
      language: 'markdown',
      mode: 'edit',
      isDirty
    }) as EditorExternalWatchTargetState['openFiles'][number]

  const makeState = (args: {
    repo: EditorExternalWatchTargetState['repos'][number]
    worktree: EditorExternalWatchTargetState['worktreesByRepo'][string][number]
    openFiles?: EditorExternalWatchTargetState['openFiles']
    activeWorktreeId?: string | null
    runtimeEnvironmentId?: string | null
    rightSidebarOpen?: boolean
    rightSidebarTab?: EditorExternalWatchTargetState['rightSidebarTab']
    rightSidebarExplorerView?: EditorExternalWatchTargetState['rightSidebarExplorerView']
    gitStatusHugeByWorktree?: EditorExternalWatchTargetState['gitStatusHugeByWorktree']
    sshConnectionStates?: EditorExternalWatchTargetState['sshConnectionStates']
    folderWorkspaces?: EditorExternalWatchTargetState['folderWorkspaces']
    projectGroups?: EditorExternalWatchTargetState['projectGroups']
    worktreesByRepo?: EditorExternalWatchTargetState['worktreesByRepo']
    repos?: EditorExternalWatchTargetState['repos']
  }): EditorExternalWatchTargetState => ({
    openFiles: args.openFiles ?? [],
    // Why: callers can pass stable identities; the default literals otherwise miss the memo guard on every call, making guard conjuncts untestable.
    worktreesByRepo: args.worktreesByRepo ?? { [args.repo.id]: [args.worktree] },
    repos: args.repos ?? [args.repo],
    folderWorkspaces: args.folderWorkspaces ?? [],
    projectGroups: args.projectGroups ?? [],
    activeWorktreeId: args.activeWorktreeId ?? null,
    rightSidebarOpen: args.rightSidebarOpen ?? false,
    rightSidebarTab: args.rightSidebarTab ?? 'explorer',
    rightSidebarExplorerView: args.rightSidebarExplorerView ?? 'files',
    gitStatusHugeByWorktree: args.gitStatusHugeByWorktree ?? EMPTY_GIT_STATUS_HUGE,
    sshConnectionStates: args.sshConnectionStates ?? EMPTY_SSH_STATES,
    restoredRuntimeHostIdByWorkspaceSessionKey: EMPTY_RESTORED_HOST_IDS,
    runtimeEnvironments: EMPTY_RUNTIME_ENVS,
    settings:
      args.runtimeEnvironmentId === undefined
        ? null
        : ({
            activeRuntimeEnvironmentId: args.runtimeEnvironmentId
          } as EditorExternalWatchTargetState['settings'])
  })

  it('preserves the snapshot when open-file metadata changes without changing watched roots', () => {
    const repo = makeRepo('repo-1')
    const worktree = makeWorktree(repo.id, 'wt-1')
    const first = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false)] })
    )
    const second = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, true)] })
    )

    expect(second).toBe(first)
    expect(second.targets).toEqual([
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo-1/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('does not watch the active worktree while the sidebar is hidden', () => {
    const repo = makeRepo('repo-active')
    const worktree = makeWorktree(repo.id, 'wt-active')

    expect(
      getEditorExternalWatchTargets(makeState({ repo, worktree, activeWorktreeId: worktree.id }))
        .targets
    ).toEqual([])
  })

  it('keeps watching the active worktree when the file explorer is visible', () => {
    const repo = makeRepo('repo-active-visible')
    const worktree = makeWorktree(repo.id, 'wt-active-visible')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer'
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'wt-active-visible',
        worktreePath: '/repo-active-visible/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('does not watch the active worktree while Explorer search is visible', () => {
    const repo = makeRepo('repo-active-search')
    const worktree = makeWorktree(repo.id, 'wt-active-search')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer',
          rightSidebarExplorerView: 'search'
        })
      ).targets
    ).toEqual([])
  })

  it('keeps watching the active worktree when Source Control is visible', () => {
    const repo = makeRepo('repo-source-control')
    const worktree = makeWorktree(repo.id, 'wt-source-control')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'source-control'
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'wt-source-control',
        worktreePath: '/repo-source-control/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('does not watch Source Control-only worktrees when git status is paused as huge', () => {
    const repo = makeRepo('repo-source-control-huge')
    const worktree = makeWorktree(repo.id, 'wt-source-control-huge')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'source-control',
          gitStatusHugeByWorktree: { [worktree.id]: { limit: 1000 } }
        })
      ).targets
    ).toEqual([])
  })

  it('does not watch Source Control-only SSH worktrees while disconnected', () => {
    const repo = makeRepo('repo-source-control-ssh', 'ssh-1')
    const worktree = makeWorktree(repo.id, 'wt-source-control-ssh')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'source-control',
          sshConnectionStates: new Map([['ssh-1', { status: 'disconnected' } as never]])
        })
      ).targets
    ).toEqual([])
  })

  it('watches Source Control-only SSH worktrees when connected', () => {
    const repo = makeRepo('repo-source-control-ssh-connected', 'ssh-1')
    const worktree = makeWorktree(repo.id, 'wt-source-control-ssh-connected')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: worktree.id,
          rightSidebarOpen: true,
          rightSidebarTab: 'source-control',
          sshConnectionStates: new Map([['ssh-1', { status: 'connected' } as never]])
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'wt-source-control-ssh-connected',
        worktreePath: '/repo-source-control-ssh-connected/worktree',
        connectionId: 'ssh-1',
        runtimeEnvironmentId: null
      }
    ])
  })

  it('rebuilds ownerless targets when an SSH connection id hydrates', () => {
    const localRepo = makeRepo('repo-remote', null)
    const remoteRepo = makeRepo('repo-remote', 'ssh-1')
    const worktree = makeWorktree(localRepo.id, 'wt-remote')
    const local = getEditorExternalWatchTargets(
      makeState({ repo: localRepo, worktree, openFiles: [makeOpenFile(worktree.id)] })
    )
    const remote = getEditorExternalWatchTargets(
      makeState({
        repo: remoteRepo,
        worktree,
        openFiles: [makeOpenFile(worktree.id)],
        runtimeEnvironmentId: ' runtime-1 '
      })
    )

    expect(remote).not.toBe(local)
    expect(remote.targets).toEqual([
      {
        worktreeId: 'wt-remote',
        worktreePath: '/repo-remote/worktree',
        connectionId: 'ssh-1',
        runtimeEnvironmentId: null
      }
    ])
  })

  it('creates separate watch targets for local and runtime-owned tabs in the same worktree', () => {
    const repo = makeRepo('repo-mixed')
    const worktree = makeWorktree(repo.id, 'wt-mixed')
    const localFile = makeOpenFile(worktree.id)
    const runtimeFile = {
      ...makeOpenFile(worktree.id),
      id: 'runtime-file',
      runtimeEnvironmentId: 'env-1'
    }

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [localFile, runtimeFile],
          runtimeEnvironmentId: null
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'wt-mixed',
        worktreePath: '/repo-mixed/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'wt-mixed',
        worktreePath: '/repo-mixed/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: 'env-1'
      }
    ])
  })

  it('keeps restored ownerless tabs local when an active runtime is selected', () => {
    const repo = makeRepo('repo-restored')
    const worktree = makeWorktree(repo.id, 'wt-restored')
    const restoredLocalFile = {
      ...makeOpenFile(worktree.id),
      id: 'restored-local-file',
      runtimeEnvironmentId: undefined
    }
    const runtimeFile = {
      ...makeOpenFile(worktree.id),
      id: 'runtime-file',
      runtimeEnvironmentId: 'env-1'
    }

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [restoredLocalFile, runtimeFile],
          runtimeEnvironmentId: 'env-1'
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'wt-restored',
        worktreePath: '/repo-restored/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'wt-restored',
        worktreePath: '/repo-restored/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: 'env-1'
      }
    ])
  })

  const makeFolderWorkspace = (
    id: string,
    folderPath: string,
    projectGroupId = 'group-1',
    connectionId: string | null = null
  ): EditorExternalWatchTargetState['folderWorkspaces'][number] =>
    ({
      id,
      projectGroupId,
      name: id,
      folderPath,
      connectionId
    }) as EditorExternalWatchTargetState['folderWorkspaces'][number]

  const makeProjectGroup = (
    id: string,
    connectionId: string | null = null
  ): EditorExternalWatchTargetState['projectGroups'][number] =>
    ({ id, name: id, connectionId }) as EditorExternalWatchTargetState['projectGroups'][number]

  it('watches a folder workspace opened from the editor even though it is not in worktreesByRepo', () => {
    const repo = makeRepo('repo-folder-open')
    const worktree = makeWorktree(repo.id, 'wt-folder-open')
    const folderWorkspace = makeFolderWorkspace('fw-1', '/folders/proj')
    const openFile = {
      ...makeOpenFile('folder:fw-1'),
      id: 'folder-file'
    }

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [openFile],
          folderWorkspaces: [folderWorkspace],
          projectGroups: [makeProjectGroup('group-1')]
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'folder:fw-1',
        worktreePath: '/folders/proj',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('watches the active folder workspace for the Explorer sidebar', () => {
    const repo = makeRepo('repo-folder-sidebar')
    const worktree = makeWorktree(repo.id, 'wt-folder-sidebar')
    const folderWorkspace = makeFolderWorkspace('fw-2', '/folders/sidebar-proj')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          activeWorktreeId: 'folder:fw-2',
          rightSidebarOpen: true,
          rightSidebarTab: 'explorer',
          rightSidebarExplorerView: 'files',
          folderWorkspaces: [folderWorkspace],
          projectGroups: [makeProjectGroup('group-1')]
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'folder:fw-2',
        worktreePath: '/folders/sidebar-proj',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('routes a remote folder workspace through its own connection, falling back to the group', () => {
    const repo = makeRepo('repo-folder-remote')
    const worktree = makeWorktree(repo.id, 'wt-folder-remote')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [{ ...makeOpenFile('folder:fw-own'), id: 'own-conn-file' }],
          folderWorkspaces: [makeFolderWorkspace('fw-own', '/folders/own', 'group-1', 'ssh-own')],
          projectGroups: [makeProjectGroup('group-1', 'ssh-group')]
        })
      ).targets[0]?.connectionId
    ).toBe('ssh-own')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [{ ...makeOpenFile('folder:fw-inherit'), id: 'inherit-conn-file' }],
          folderWorkspaces: [
            makeFolderWorkspace('fw-inherit', '/folders/inherit', 'group-1', null)
          ],
          projectGroups: [makeProjectGroup('group-1', 'ssh-group')]
        })
      ).targets[0]?.connectionId
    ).toBe('ssh-group')
  })

  it('drops only the unknown folder workspace and still emits the known one', () => {
    const repo = makeRepo('repo-folder-missing')
    const worktree = makeWorktree(repo.id, 'wt-folder-missing')

    // Why: asserting [] alone passes even with the folder branch deleted; pairing a known workspace with an unknown one makes the assertion mutation-sensitive.
    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [
            { ...makeOpenFile('folder:fw-known'), id: 'known-file' },
            { ...makeOpenFile('folder:fw-gone'), id: 'gone-file' }
          ],
          folderWorkspaces: [makeFolderWorkspace('fw-known', '/folders/known')],
          projectGroups: [makeProjectGroup('group-1')]
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'folder:fw-known',
        worktreePath: '/folders/known',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('emits a folder workspace and a git worktree together, sorted by worktree id', () => {
    const repo = makeRepo('repo-coexist')
    const worktree = makeWorktree(repo.id, 'wt-coexist')

    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [
            { ...makeOpenFile(worktree.id), id: 'git-file' },
            { ...makeOpenFile('folder:fw-coexist'), id: 'folder-file' }
          ],
          folderWorkspaces: [makeFolderWorkspace('fw-coexist', '/folders/coexist')],
          projectGroups: [makeProjectGroup('group-1')]
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'folder:fw-coexist',
        worktreePath: '/folders/coexist',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'wt-coexist',
        worktreePath: '/repo-coexist/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('reuses the cached snapshot only while every guarded input keeps its identity', () => {
    const repo = makeRepo('repo-guard')
    const worktree = makeWorktree(repo.id, 'wt-guard')
    // Why: identities are hoisted so the guard can actually be reached; rebuilding them per call misses it every time and leaves every conjunct untested.
    const worktreesByRepo = { [repo.id]: [worktree] }
    const repos = [repo]
    const openFiles = [{ ...makeOpenFile('folder:fw-guard'), id: 'guard-file' }]
    const folderWorkspaces = [makeFolderWorkspace('fw-guard', '/folders/guard')]
    const projectGroups = [makeProjectGroup('group-1')]
    const shared = { repo, worktree, worktreesByRepo, repos, openFiles, projectGroups }

    const first = getEditorExternalWatchTargets(makeState({ ...shared, folderWorkspaces }))
    expect(first.targets).toEqual([
      {
        worktreeId: 'folder:fw-guard',
        worktreePath: '/folders/guard',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])

    // Same identities everywhere: the guard must short-circuit.
    expect(getEditorExternalWatchTargets(makeState({ ...shared, folderWorkspaces }))).toBe(first)

    // folderWorkspaces identity changes to a workspace at a NEW path: the guard must NOT short-circuit.
    const moved = getEditorExternalWatchTargets(
      makeState({
        ...shared,
        folderWorkspaces: [makeFolderWorkspace('fw-guard', '/folders/moved')]
      })
    )
    expect(moved.targets[0]?.worktreePath).toBe('/folders/moved')

    // projectGroups identity changes in a way that changes the resolved connection: the guard must NOT short-circuit.
    const rerouted = getEditorExternalWatchTargets(
      makeState({
        ...shared,
        folderWorkspaces: [makeFolderWorkspace('fw-guard', '/folders/moved', 'group-1', null)],
        projectGroups: [makeProjectGroup('group-1', 'ssh-rerouted')]
      })
    )
    expect(rerouted.targets[0]?.connectionId).toBe('ssh-rerouted')
  })

  it('returns the identical snapshot when folderWorkspaces is reallocated but equivalent', () => {
    const repo = makeRepo('repo-folder-stable')
    const worktree = makeWorktree(repo.id, 'wt-folder-stable')
    const openFiles = [{ ...makeOpenFile('folder:fw-stable'), id: 'stable-file' }]
    const projectGroups = [makeProjectGroup('group-1')]

    const first = getEditorExternalWatchTargets(
      makeState({
        repo,
        worktree,
        openFiles,
        folderWorkspaces: [makeFolderWorkspace('fw-stable', '/folders/stable')],
        projectGroups
      })
    )
    // Why: a fresh-but-equivalent array must not churn the snapshot, or the [targetsKey] effect re-runs and thrashes watch/unwatch IPC.
    const second = getEditorExternalWatchTargets(
      makeState({
        repo,
        worktree,
        openFiles,
        folderWorkspaces: [makeFolderWorkspace('fw-stable', '/folders/stable')],
        projectGroups: [makeProjectGroup('group-1')]
      })
    )

    expect(second).toBe(first)
  })

  it('recomputes targets when folderWorkspaces changes identity', () => {
    const repo = makeRepo('repo-folder-memo')
    const worktree = makeWorktree(repo.id, 'wt-folder-memo')
    const openFiles = [{ ...makeOpenFile('folder:fw-memo'), id: 'memo-file' }]
    const projectGroups = [makeProjectGroup('group-1')]

    const before = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles, folderWorkspaces: [], projectGroups })
    )
    expect(before.targets).toEqual([])

    const after = getEditorExternalWatchTargets(
      makeState({
        repo,
        worktree,
        openFiles,
        folderWorkspaces: [makeFolderWorkspace('fw-memo', '/folders/memo')],
        projectGroups
      })
    )
    expect(after.targets).toEqual([
      {
        worktreeId: 'folder:fw-memo',
        worktreePath: '/folders/memo',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('emits both folder workspaces that share one folder path (the default in a folder-backed group)', () => {
    const repo = makeRepo('repo-shared-path')
    const worktree = makeWorktree(repo.id, 'wt-shared-path')

    // Why: createFolderWorkspace defaults folderPath to the group's parentPath and enforces no uniqueness, so siblings in one group normally share a path.
    expect(
      getEditorExternalWatchTargets(
        makeState({
          repo,
          worktree,
          openFiles: [
            { ...makeOpenFile('folder:fw-a'), id: 'a-file' },
            { ...makeOpenFile('folder:fw-b'), id: 'b-file' }
          ],
          folderWorkspaces: [
            makeFolderWorkspace('fw-a', '/group/parent'),
            makeFolderWorkspace('fw-b', '/group/parent')
          ],
          projectGroups: [makeProjectGroup('group-1')]
        })
      ).targets
    ).toEqual([
      {
        worktreeId: 'folder:fw-a',
        worktreePath: '/group/parent',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'folder:fw-b',
        worktreePath: '/group/parent',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  describe('sharesLocalWatchRoot', () => {
    const target = (
      worktreeId: string,
      worktreePath: string,
      connectionId?: string,
      runtimeEnvironmentId: string | null = null
    ): Parameters<typeof sharesLocalWatchRoot>[0] => ({
      worktreeId,
      worktreePath,
      connectionId,
      runtimeEnvironmentId
    })

    it('treats sibling folder workspaces on one path as one local watch root', () => {
      expect(
        sharesLocalWatchRoot(
          target('folder:a', '/group/parent'),
          target('folder:b', '/group/parent')
        )
      ).toBe(true)
    })

    it('treats a folder workspace colliding with a git worktree path as one local watch root', () => {
      expect(
        sharesLocalWatchRoot(target('folder:c', '/repo-1/wt'), target('wt-1', '/repo-1/wt'))
      ).toBe(true)
    })

    it('does not merge different paths, different connections, or runtime-owned targets', () => {
      expect(sharesLocalWatchRoot(target('folder:a', '/one'), target('folder:b', '/two'))).toBe(
        false
      )
      expect(
        sharesLocalWatchRoot(
          target('folder:a', '/same', 'ssh-1'),
          target('folder:b', '/same', undefined)
        )
      ).toBe(false)
      // Runtime-owned targets unsubscribe through their own handle, not the path-keyed local watcher.
      expect(
        sharesLocalWatchRoot(
          target('folder:a', '/same', undefined, 'env-1'),
          target('folder:b', '/same', undefined, 'env-1')
        )
      ).toBe(false)
    })
  })
})
