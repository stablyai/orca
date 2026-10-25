import { describe, expect, it, vi } from 'vitest'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'
import {
  PINNED_RECURSIVE_WATCH_WORKSPACE_COUNT,
  WARM_RECURSIVE_WATCH_WORKSPACE_COUNT
} from './editor-external-watch-scope'
import { getWorktreeVisitKey } from '@/lib/worktree-visit-recency'
import { getDefaultSettings } from '../../../shared/constants'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

type Repo = EditorExternalWatchTargetState['repos'][number]
type Worktree = EditorExternalWatchTargetState['worktreesByRepo'][string][number]
type OpenFile = EditorExternalWatchTargetState['openFiles'][number]
type FolderWorkspace = EditorExternalWatchTargetState['folderWorkspaces'][number]

const repo = (id: string, connectionId: string | null = null): Repo => ({
  ...TEST_REPO,
  id,
  path: `/${id}`,
  kind: 'git',
  connectionId
})

const worktree = (repoId: string, id: string, path = `/${repoId}/${id}`): Worktree =>
  makeWorktree({ id, repoId, path })

const tab = (worktreeId: string, extra: Partial<OpenFile> = {}): OpenFile => ({
  id: `${worktreeId}-file`,
  worktreeId,
  filePath: `/x/${worktreeId}/a.ts`,
  relativePath: 'a.ts',
  language: 'typescript',
  mode: 'edit',
  isDirty: false,
  ...extra
})

function makeState(args: {
  worktrees: Worktree[]
  repos?: Repo[]
  openFiles: OpenFile[]
  activeWorktreeId?: string | null
  visits?: Record<string, number>
  folderWorkspaces?: FolderWorkspace[]
}): EditorExternalWatchTargetState {
  const worktreesByRepo: EditorExternalWatchTargetState['worktreesByRepo'] = {}
  for (const wt of args.worktrees) {
    ;(worktreesByRepo[wt.repoId] ??= []).push(wt)
  }
  return {
    openFiles: args.openFiles,
    worktreesByRepo,
    repos: args.repos ?? [repo('r')],
    activeWorktreeId: args.activeWorktreeId ?? null,
    lastVisitedAtByWorktreeId: args.visits ?? {},
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map(),
    folderWorkspaces: args.folderWorkspaces ?? [],
    projectGroups: [],
    settings: getDefaultSettings('/tmp')
  }
}

const watchedIds = (state: EditorExternalWatchTargetState): string[] =>
  selectEditorExternalWatchTargets(state).targets.map((target) => target.worktreeId)

describe('background workspace watch trim', () => {
  const ids = ['wt0', 'wt1', 'wt2', 'wt3', 'wt4']
  const worktrees = ids.map((id) => worktree('r', id))

  it('watches the active workspace and drops clean background ones', () => {
    const state = makeState({
      worktrees,
      openFiles: [tab('wt0'), tab('wt1')],
      activeWorktreeId: 'wt0'
    })
    expect(watchedIds(state)).toEqual(['wt0'])
    expect([...selectEditorExternalWatchTargets(state).unwatchedTargetKeys]).toEqual([
      'wt1::/r/wt1::local::client::literal'
    ])
  })

  it(`keeps the ${WARM_RECURSIVE_WATCH_WORKSPACE_COUNT} most recently visited workspaces and evicts older ones`, () => {
    const state = makeState({
      worktrees,
      openFiles: ids.map((id) => tab(id)),
      activeWorktreeId: 'wt0',
      // Why: mixes host-qualified and legacy bare keys, as persisted sessions do.
      visits: {
        wt0: 50,
        [getWorktreeVisitKey('wt1', 'local')]: 1,
        wt2: 2,
        [getWorktreeVisitKey('wt3', 'local')]: 3,
        wt4: 4
      }
    })
    expect(watchedIds(state)).toEqual(['wt0', 'wt2', 'wt3', 'wt4'])
  })

  it('does not let a deleted workspace hold a warm slot', () => {
    const state = makeState({
      worktrees,
      openFiles: ids.map((id) => tab(id)),
      activeWorktreeId: 'wt0',
      visits: { gone: 100, 'also-gone': 99, wt1: 1, wt2: 2, wt3: 3 }
    })
    expect(watchedIds(state)).toEqual(['wt0', 'wt1', 'wt2', 'wt3'])
  })

  it('releases a background workspace even with unsaved, combined diff or rich edit tabs', () => {
    // Why: every editor save is disk-checked by the host now, so no edit surface needs a live watch.
    const state = makeState({
      worktrees,
      openFiles: [
        tab('wt0'),
        tab('wt1', { isDirty: true }),
        tab('wt2', { id: 'combined', mode: 'diff', diffSource: 'combined-uncommitted' }),
        tab('wt3', { id: 'md', language: 'markdown' }),
        tab('wt4', { id: 'csv', language: 'csv' })
      ],
      activeWorktreeId: 'wt0'
    })
    expect(watchedIds(state)).toEqual(['wt0'])
  })

  it.each(['deleted', 'renamed'] as const)(
    'keeps a background workspace with a clean %s tab watched',
    (externalMutation) => {
      const state = makeState({
        worktrees,
        openFiles: [tab('wt0'), tab('wt1', { externalMutation }), tab('wt2')],
        activeWorktreeId: 'wt0'
      })
      expect(watchedIds(state)).toEqual(['wt0', 'wt1'])
    }
  )

  it(`keeps at most ${PINNED_RECURSIVE_WATCH_WORKSPACE_COUNT} deleted/renamed-tab workspaces beyond the recent ones, evicting the least recent`, () => {
    const pinnedIds = ['p1', 'p2', 'p3', 'p4', 'p5']
    const state = makeState({
      worktrees: [...worktrees, ...pinnedIds.map((id) => worktree('r', id))],
      openFiles: [
        tab('wt0'),
        tab('wt1'),
        tab('wt2'),
        tab('wt3'),
        ...pinnedIds.map((id) => tab(id, { externalMutation: 'deleted' as const }))
      ],
      activeWorktreeId: 'wt0',
      visits: { wt1: 100, wt2: 99, wt3: 98, p1: 1, p2: 2, p3: 3, p4: 4 }
    })
    expect(watchedIds(state)).toEqual(['p2', 'p3', 'p4', 'wt0', 'wt1', 'wt2', 'wt3'])
    // Why: an evicted pin is released like any other workspace, so switching back still catches it up.
    expect([...selectEditorExternalWatchTargets(state).unwatchedTargetKeys].sort()).toEqual([
      'p1::/r/p1::local::client::literal',
      'p5::/r/p5::local::client::literal'
    ])
  })

  it('never watches for a virtual tab', () => {
    const state = makeState({
      worktrees,
      openFiles: [tab('wt0', { mode: 'check-details' })],
      activeWorktreeId: 'wt0'
    })
    expect(watchedIds(state)).toEqual([])
  })

  it('recomputes when the visit map changes', () => {
    const state = makeState({
      worktrees,
      openFiles: [tab('wt0'), tab('wt1')],
      activeWorktreeId: 'wt0'
    })
    expect(watchedIds(state)).toEqual(['wt0'])
    expect(watchedIds({ ...state, lastVisitedAtByWorktreeId: { wt1: 1 } })).toEqual(['wt0', 'wt1'])
  })

  it('applies the same policy to SSH, runtime-owned and WSL workspaces', () => {
    const sshRepo = repo('ssh-repo', 'ssh-1')
    const sshWorktree = worktree('ssh-repo', 'wt-ssh', '/remote/wt-ssh')
    const wslWorktree = worktree('r', 'wt-wsl', '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt')
    const openFiles = [
      tab('wt0'),
      tab('wt-ssh'),
      tab('wt1', { id: 'runtime-tab', runtimeEnvironmentId: 'env-1' }),
      tab('wt-wsl')
    ]
    const state = makeState({
      worktrees: [...worktrees, sshWorktree, wslWorktree],
      repos: [repo('r'), sshRepo],
      openFiles,
      activeWorktreeId: 'wt0'
    })
    expect(watchedIds(state)).toEqual(['wt0'])

    const recent = {
      ...state,
      lastVisitedAtByWorktreeId: { 'wt-ssh': 3, wt1: 2, 'wt-wsl': 1 }
    }
    expect(selectEditorExternalWatchTargets(recent).targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktreeId: 'wt-ssh', connectionId: 'ssh-1' }),
        expect.objectContaining({ worktreeId: 'wt1', runtimeEnvironmentId: 'env-1' }),
        expect.objectContaining({ worktreeId: 'wt-wsl' })
      ])
    )
  })

  it('treats folder workspaces like worktrees', () => {
    const folder = (id: string): FolderWorkspace =>
      makeFolderWorkspace({
        id,
        projectGroupId: 'g',
        folderPath: `/folders/${id}`,
        executionHostId: 'local'
      })
    const state = makeState({
      worktrees: [],
      folderWorkspaces: [folder('a'), folder('b')],
      openFiles: [tab('folder:a'), tab('folder:b', { id: 'b' })],
      activeWorktreeId: 'folder:a'
    })
    expect(watchedIds(state)).toEqual(['folder:a'])
    expect(watchedIds({ ...state, activeWorktreeId: 'folder:b' })).toEqual(['folder:b'])
    expect(watchedIds({ ...state, lastVisitedAtByWorktreeId: { 'folder:b': 1 } })).toEqual([
      'folder:a',
      'folder:b'
    ])
  })
})
