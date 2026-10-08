import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { perforceTargetForFile } from './perforce-workspace-target'

type Row = { id: string; repoId: string; path: string }

const store = vi.hoisted((): { repos: Repo[]; worktrees: Row[]; detected: boolean } => ({
  repos: [],
  worktrees: [],
  detected: false
}))
const detect = vi.hoisted(() => vi.fn(async () => store.detected))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { activeRuntimeEnvironmentId: null },
      repos: store.repos,
      worktreesByRepo: { all: store.worktrees },
      getKnownWorktreeById: (id: string) => store.worktrees.find((row) => row.id === id)
    })
  }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getRuntimeEnvironmentIdForWorktree: () => null }))
vi.mock('./perforce-workspace-detection', () => ({ isPerforceWorkspaceForFiles: detect }))

function repo(id: string, patch: Partial<Repo>): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#888888', addedAt: 0, ...patch }
}

const context = (worktreeId: string, worktreePath: string) => ({
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId,
  worktreePath
})

beforeEach(() => {
  store.repos = [
    repo('p4', { path: '/ws', kind: 'folder', vcs: 'perforce' }),
    repo('folder', { path: '/plain', kind: 'folder' }),
    repo('git', { path: '/git' })
  ]
  store.worktrees = [
    { id: 'p4::/ws', repoId: 'p4', path: '/ws' },
    { id: 'p4::/ws.wt/one', repoId: 'p4', path: '/ws.wt/one' },
    { id: 'folder::/plain', repoId: 'folder', path: '/plain' },
    { id: 'git::/git', repoId: 'git', path: '/git' }
  ]
  store.detected = false
  detect.mockClear()
})

describe('perforceTargetForFile', () => {
  it("uses the workspace's own path, not one derived from a shelf-suffixed tab path", async () => {
    const target = await perforceTargetForFile(context('p4::/ws.wt/one', '/ws.w'))
    expect(target).toMatchObject({ worktreeId: 'p4::/ws.wt/one', worktreePath: '/ws.wt/one' })
    expect(detect).not.toHaveBeenCalled()
  })

  it('finds the Perforce workspace that holds a file opened from elsewhere', async () => {
    const target = await perforceTargetForFile(context('git::/git', '/git'), '/ws.wt/one/a.cs')
    expect(target).toMatchObject({ worktreeId: 'p4::/ws.wt/one', worktreePath: '/ws.wt/one' })
  })

  it('detects a folder project not yet marked Perforce, and leaves Git projects alone', async () => {
    await expect(perforceTargetForFile(context('folder::/plain', '/plain'))).resolves.toBeNull()
    expect(detect).toHaveBeenCalledOnce()
    store.detected = true
    await expect(perforceTargetForFile(context('folder::/plain', '/plain'))).resolves.toMatchObject(
      { worktreeId: 'folder::/plain' }
    )
    detect.mockClear()
    await expect(perforceTargetForFile(context('git::/git', '/git'))).resolves.toBeNull()
    expect(detect).not.toHaveBeenCalled()
  })
})
