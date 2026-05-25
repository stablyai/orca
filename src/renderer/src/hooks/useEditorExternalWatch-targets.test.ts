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
  }): EditorExternalWatchTargetState => ({
    openFiles: args.openFiles ?? [],
    worktreesByRepo: { [args.repo.id]: [args.worktree] },
    repos: [args.repo],
    activeWorktreeId: args.activeWorktreeId ?? null,
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
        runtimeEnvironmentId: undefined
      }
    ])
  })

  it('keeps watching the active worktree even when it has no open editor files', () => {
    const repo = makeRepo('repo-active')
    const worktree = makeWorktree(repo.id, 'wt-active')

    expect(
      getEditorExternalWatchTargets(makeState({ repo, worktree, activeWorktreeId: worktree.id }))
        .targets
    ).toEqual([
      {
        worktreeId: 'wt-active',
        worktreePath: '/repo-active/worktree',
        connectionId: undefined,
        runtimeEnvironmentId: undefined
      }
    ])
  })

  it('rebuilds targets when SSH connection or runtime environment identity changes', () => {
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
        runtimeEnvironmentId: 'runtime-1'
      }
    ])
  })
})
