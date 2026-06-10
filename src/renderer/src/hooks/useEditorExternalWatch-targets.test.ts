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
    connectionId: string | null = null
  ): EditorExternalWatchTargetState['repos'][number] =>
    ({
      id,
      path: `/${id}`,
      kind: 'git',
      connectionId
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
  }): EditorExternalWatchTargetState => ({
    openFiles: args.openFiles ?? [],
    worktreesByRepo: { [args.repo.id]: [args.worktree] },
    repos: [args.repo],
    activeWorktreeId: args.activeWorktreeId ?? null,
    rightSidebarOpen: args.rightSidebarOpen ?? false,
    rightSidebarTab: args.rightSidebarTab ?? 'explorer',
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

  it('does not watch the active worktree while the file explorer is hidden', () => {
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

  it('does not watch the active worktree when a different right sidebar tab is visible', () => {
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
    ).toEqual([])
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
})
