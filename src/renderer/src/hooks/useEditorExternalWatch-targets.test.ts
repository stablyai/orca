import { describe, expect, it, vi } from 'vitest'
import {
  getEditorExternalWatchTargets,
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
    isDirty = false,
    filePath = `${worktreeId}/notes.md`
  ): EditorExternalWatchTargetState['openFiles'][number] =>
    ({
      id: `${worktreeId}-file`,
      worktreeId,
      filePath,
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
  }): EditorExternalWatchTargetState => ({
    openFiles: args.openFiles ?? [],
    worktreesByRepo: { [args.repo.id]: [args.worktree] },
    repos: [args.repo],
    activeWorktreeId: args.activeWorktreeId ?? null,
    rightSidebarOpen: args.rightSidebarOpen ?? false,
    rightSidebarTab: args.rightSidebarTab ?? 'explorer',
    rightSidebarExplorerView: args.rightSidebarExplorerView ?? 'files',
    gitStatusHugeByWorktree: args.gitStatusHugeByWorktree ?? {},
    sshConnectionStates: args.sshConnectionStates ?? new Map(),
    folderWorkspaces: [],
    projectGroups: [],
    settings:
      args.runtimeEnvironmentId === undefined
        ? null
        : ({
            activeRuntimeEnvironmentId: args.runtimeEnvironmentId
          } as EditorExternalWatchTargetState['settings'])
  })


  it('watches the containing directory of an open file outside the worktree root (#15612)', () => {
    const repo = makeRepo('repo-scratch')
    const worktree = makeWorktree(repo.id, 'wt-scratch')
    const scratchFile = {
      ...makeOpenFile(worktree.id, false, '/tmp/claude-scratch/plan.md')
    }

    const { targets } = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [scratchFile] })
    )

    expect(targets).toEqual([
      {
        worktreeId: 'wt-scratch',
        worktreePath: '/repo-scratch/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'wt-scratch',
        worktreePath: '/tmp/claude-scratch',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('deduplicates out-of-root directory watches for files sharing a directory', () => {
    const repo = makeRepo('repo-dedupe')
    const worktree = makeWorktree(repo.id, 'wt-dedupe')
    const openFiles = [
      makeOpenFile(worktree.id, false, '/tmp/agent-docs/plan.md'),
      { ...makeOpenFile(worktree.id, false, '/tmp/agent-docs/report.md'), id: 'report-file' }
    ]

    const { targets } = getEditorExternalWatchTargets(makeState({ repo, worktree, openFiles }))

    expect(targets.filter((target) => target.worktreePath === '/tmp/agent-docs')).toHaveLength(1)
  })

  it('does not watch a directory that contains the worktree root', () => {
    const repo = makeRepo('repo-parent')
    const worktree = makeWorktree(repo.id, 'wt-parent')
    // A sibling of the worktree root: its containing directory ALSO contains the root.
    const siblingFile = makeOpenFile(worktree.id, false, '/repo-parent/notes.md')

    const { targets } = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [siblingFile] })
    )

    expect(targets).toEqual([
      {
        worktreeId: 'wt-parent',
        worktreePath: '/repo-parent/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('skips files owned by a different SSH target', () => {
    const repo = makeRepo('repo-ssh-external')
    const worktree = makeWorktree(repo.id, 'wt-ssh-external')
    const externalFile = {
      ...makeOpenFile(worktree.id, false, '/remote-scratch/plan.md'),
      externalSshTargetId: 'ssh-other'
    }

    const { targets } = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [externalFile] })
    )

    expect(targets).toHaveLength(1)
    expect(targets[0].worktreePath).toBe('/repo-ssh-external/worktree')
  })

  it('bounds the number of out-of-root directory watches', () => {
    const repo = makeRepo('repo-many')
    const worktree = makeWorktree(repo.id, 'wt-many')
    const openFiles = Array.from({ length: 12 }, (_, i) => ({
      ...makeOpenFile(worktree.id, false, `/tmp/dir-${i}/file-${i}.md`),
      id: `file-${i}`
    }))

    const { targets } = getEditorExternalWatchTargets(makeState({ repo, worktree, openFiles }))

    const dirTargets = targets.filter((target) => target.worktreePath.startsWith('/tmp/dir-'))
    expect(dirTargets).toHaveLength(8)
  })

  it('preserves the snapshot when open-file metadata changes without changing watched roots', () => {
    const repo = makeRepo('repo-1')
    const worktree = makeWorktree(repo.id, 'wt-1')
    const first = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false, '/repo-1/worktree/notes.md')] })
    )
    const second = getEditorExternalWatchTargets(
      makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, true, '/repo-1/worktree/notes.md')] })
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

  it('enables WSL aliases for a proven-local Windows drive watcher', () => {
    const repo = makeRepo('repo-local-drive', null, 'local')
    const worktree = makeWorktree(repo.id, 'wt-local-drive')
    worktree.path = 'C:\\repo'
    worktree.hostId = 'local'
    const state = makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false, 'C:' + String.fromCharCode(92) + 'repo' + String.fromCharCode(92) + 'notes.md')] })
    state.repos = [makeRepo(repo.id, 'ssh-1', 'ssh:ssh-1'), repo]

    expect(getEditorExternalWatchTargets(state).targets).toEqual([
      {
        worktreeId: 'wt-local-drive',
        worktreePath: 'C:\\repo',
        connectionId: undefined,
        runtimeEnvironmentId: null,
        allowLocalWindowsWslAliases: true
      }
    ])
  })

  it('does not infer a local alias owner while repo metadata is missing', () => {
    const repo = makeRepo('repo-unresolved', null, 'local')
    const worktree = makeWorktree(repo.id, 'wt-unresolved')
    worktree.path = 'C:\\repo'
    worktree.hostId = 'local'
    const state = makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false, 'C:' + String.fromCharCode(92) + 'repo' + String.fromCharCode(92) + 'notes.md')] })
    state.repos = []

    expect(getEditorExternalWatchTargets(state).targets).toEqual([
      {
        worktreeId: 'wt-unresolved',
        worktreePath: 'C:\\repo',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it.each(['worktree', 'repo'] as const)(
    'does not grant local aliases while the %s host stamp is missing',
    (stampOwner) => {
      const repo = makeRepo('repo-missing-host', null, 'local')
      const worktree = makeWorktree(repo.id, 'wt-missing-host')
      worktree.path = 'C:\\repo'
      worktree.hostId = 'local'
      if (stampOwner === 'worktree') {
        worktree.hostId = undefined
      } else {
        repo.executionHostId = undefined
      }

      const target = getEditorExternalWatchTargets(
        makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false, 'C:' + String.fromCharCode(92) + 'repo' + String.fromCharCode(92) + 'notes.md')] })
      ).targets[0]

      expect(target).not.toHaveProperty('allowLocalWindowsWslAliases')
    }
  )

  it.each(['worktree', 'repo'] as const)(
    'does not grant local aliases for an unknown %s host stamp',
    (stampOwner) => {
      const repo = makeRepo('repo-unknown-host')
      const worktree = makeWorktree(repo.id, 'wt-unknown-host')
      worktree.path = 'C:\\repo'
      worktree.hostId = 'local'
      repo.executionHostId = 'local'
      if (stampOwner === 'worktree') {
        worktree.hostId = 'future:host' as never
      } else {
        repo.executionHostId = 'future:host' as never
      }

      const target = getEditorExternalWatchTargets(
        makeState({ repo, worktree, openFiles: [makeOpenFile(worktree.id, false, 'C:' + String.fromCharCode(92) + 'repo' + String.fromCharCode(92) + 'notes.md')] })
      ).targets[0]

      expect(target).not.toHaveProperty('allowLocalWindowsWslAliases')
    }
  )

  it('enables WSL aliases for a proven-local folder workspace', () => {
    const repo = makeRepo('unused', null, 'local')
    const worktree = makeWorktree(repo.id)
    const folderWorkspaceId = 'folder-local'
    const workspaceKey = `folder:${folderWorkspaceId}`
    const state = makeState({
      repo,
      worktree,
      openFiles: [makeOpenFile(workspaceKey, false, 'C:' + String.fromCharCode(92) + 'folder' + String.fromCharCode(92) + 'notes.md')]
    })
    state.folderWorkspaces = [
      {
        id: folderWorkspaceId,
        projectGroupId: 'group-local',
        folderPath: 'C:\\folder',
        executionHostId: 'local'
      } as EditorExternalWatchTargetState['folderWorkspaces'][number]
    ]
    state.projectGroups = [
      {
        id: 'group-local',
        executionHostId: 'runtime:env-1'
      } as EditorExternalWatchTargetState['projectGroups'][number],
      {
        id: 'group-local',
        executionHostId: 'local'
      } as EditorExternalWatchTargetState['projectGroups'][number]
    ]

    expect(getEditorExternalWatchTargets(state).targets).toEqual([
      {
        worktreeId: workspaceKey,
        worktreePath: 'C:\\folder',
        connectionId: undefined,
        runtimeEnvironmentId: null,
        allowLocalWindowsWslAliases: true
      }
    ])
  })

  it.each(['ssh', 'missing-group'] as const)(
    'does not grant local aliases for a %s folder workspace owner',
    (ownerCase) => {
      const repo = makeRepo('unused', null, 'local')
      const worktree = makeWorktree(repo.id)
      const folderWorkspaceId = `folder-${ownerCase}`
      const workspaceKey = `folder:${folderWorkspaceId}`
      const state = makeState({
        repo,
        worktree,
        openFiles: [makeOpenFile(workspaceKey, false, 'C:' + String.fromCharCode(92) + 'folder' + String.fromCharCode(92) + 'notes.md')]
      })
      state.folderWorkspaces = [
        {
          id: folderWorkspaceId,
          projectGroupId: `group-${ownerCase}`,
          folderPath: 'C:\\folder',
          executionHostId: ownerCase === 'ssh' ? 'ssh:target-1' : 'local'
        } as EditorExternalWatchTargetState['folderWorkspaces'][number]
      ]
      state.projectGroups =
        ownerCase === 'ssh'
          ? [
              {
                id: 'group-ssh',
                executionHostId: 'ssh:target-1'
              } as EditorExternalWatchTargetState['projectGroups'][number]
            ]
          : []

      expect(getEditorExternalWatchTargets(state).targets[0]).not.toHaveProperty(
        'allowLocalWindowsWslAliases'
      )
    }
  )

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

  it('keeps a paired runtime SSH Source Control watcher routed through its runtime repo', () => {
    const repo = makeRepo('repo-paired', null, 'runtime:env-1')
    const worktree = makeWorktree(repo.id, 'wt-paired')
    worktree.hostId = 'ssh:private-target'
    worktree.runtimeOwnerEnvironmentId = 'env-1'

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
        worktreeId: 'wt-paired',
        worktreePath: '/repo-paired/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: 'env-1'
      }
    ])
  })

  it('rebuilds ownerless targets when an SSH connection id hydrates', () => {
    const localRepo = makeRepo('repo-remote', null)
    const remoteRepo = makeRepo('repo-remote', 'ssh-1')
    const worktree = makeWorktree(localRepo.id, 'wt-remote')
    const local = getEditorExternalWatchTargets(
      makeState({ repo: localRepo, worktree, openFiles: [makeOpenFile(worktree.id, false, '/repo-remote/worktree/notes.md')] })
    )
    const remote = getEditorExternalWatchTargets(
      makeState({
        repo: remoteRepo,
        worktree,
        openFiles: [makeOpenFile(worktree.id, false, '/repo-remote/worktree/notes.md')],
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
    const localFile = makeOpenFile(worktree.id, false, '/repo-mixed/worktree/notes.md')
    const runtimeFile = {
      ...makeOpenFile(worktree.id, false, '/repo-mixed/worktree/notes.md'),
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
      ...makeOpenFile(worktree.id, false, '/repo-restored/worktree/notes.md'),
      id: 'restored-local-file',
      runtimeEnvironmentId: undefined
    }
    const runtimeFile = {
      ...makeOpenFile(worktree.id, false, '/repo-restored/worktree/notes.md'),
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
})
