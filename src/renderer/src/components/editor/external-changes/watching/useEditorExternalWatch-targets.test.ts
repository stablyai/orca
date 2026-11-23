import { describe, expect, it, vi } from 'vitest'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/workspace/ownership/worktree-operation-generation'
import type { EditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import {
  selectEditorExternalWatchTargets as getEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
vi.mock('@/components/editor/autosave/editor-autosave', () => ({
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

  const capturedLocalProvenance = (): EditorFileOperationProvenance => ({
    generation: captureWorktreeOperationGenerationSnapshot({
      executionHostId: 'local',
      runtimeEnvironmentId: null
    }),
    ownershipProjection: 'explicit'
  })

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
    // Why: these cases cover target resolution; a recent visit keeps the workspace inside the watch scope.
    lastVisitedAtByWorktreeId: Object.fromEntries(
      (args.openFiles ?? []).map((file) => [file.worktreeId, 1])
    ),
    settings:
      args.runtimeEnvironmentId === undefined
        ? null
        : ({
            activeRuntimeEnvironmentId: args.runtimeEnvironmentId
          } as EditorExternalWatchTargetState['settings'])
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
    worktree.hostId = 'local'
    const localFile = {
      ...makeOpenFile(worktree.id),
      operationProvenance: capturedLocalProvenance()
    }
    const runtimeFile = {
      ...makeOpenFile(worktree.id),
      id: 'runtime-file',
      runtimeEnvironmentId: 'env-1'
    }

    expect(
      getEditorExternalWatchTargets({
        ...makeState({
          repo,
          worktree,
          openFiles: [localFile, runtimeFile],
          runtimeEnvironmentId: null
        }),
        repos: [repo, { ...repo, executionHostId: 'runtime:env-1' }],
        worktreesByRepo: {
          [repo.id]: [worktree, { ...worktree, hostId: 'runtime:env-1' }]
        }
      }).targets
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

  it('keeps restored captured-local ownership when an active runtime is selected', () => {
    const repo = makeRepo('repo-restored')
    const worktree = makeWorktree(repo.id, 'wt-restored')
    worktree.hostId = 'local'
    const restoredLocalFile = {
      ...makeOpenFile(worktree.id),
      id: 'restored-local-file',
      runtimeEnvironmentId: undefined,
      operationProvenance: capturedLocalProvenance()
    }
    const runtimeFile = {
      ...makeOpenFile(worktree.id),
      id: 'runtime-file',
      runtimeEnvironmentId: 'env-1'
    }

    expect(
      getEditorExternalWatchTargets({
        ...makeState({
          repo,
          worktree,
          openFiles: [restoredLocalFile, runtimeFile],
          runtimeEnvironmentId: 'env-1'
        }),
        repos: [repo, { ...repo, executionHostId: 'runtime:env-1' }],
        worktreesByRepo: {
          [repo.id]: [worktree, { ...worktree, hostId: 'runtime:env-1' }]
        }
      }).targets
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
