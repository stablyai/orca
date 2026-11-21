import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { perforceProjectTarget, perforceTargetForFile } from './perforce-workspace-target'

type Row = { id: string; repoId: string; path: string; hostId?: `runtime:${string}` }

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
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null,
  // Like the real resolver, an id shared by twins resolves only when the row names its host.
  resolveOwnerOrLocal: (_state: unknown, ref: { hostId?: string }) =>
    ref.hostId?.startsWith('runtime:')
      ? {
          kind: 'resolved',
          owner: { endpoint: { kind: 'environment', environmentId: ref.hostId.slice(8) } }
        }
      : { kind: 'ambiguous' }
}))
vi.mock('./perforce-workspace-detection', () => ({ isPerforceWorkspaceForFiles: detect }))

function repo(id: string, patch: Partial<Repo>): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#888888', addedAt: 0, ...patch }
}

const context = (worktreeId: string, worktreePath: string) => ({
  target: { kind: 'local' as const },
  worktreeId,
  worktreePath
})

beforeEach(() => {
  store.repos = [
    repo('p4', { path: '/ws', kind: 'folder', vcs: 'perforce' }),
    repo('folder', { path: '/plain', kind: 'folder' }),
    repo('git', { path: '/git' }),
    repo('remote', { path: '/remote', kind: 'folder', vcs: 'perforce', connectionId: 'box' })
  ]
  store.worktrees = [
    { id: 'p4::/ws', repoId: 'p4', path: '/ws' },
    { id: 'p4::/ws.wt/one', repoId: 'p4', path: '/ws.wt/one' },
    { id: 'folder::/plain', repoId: 'folder', path: '/plain' },
    { id: 'git::/git', repoId: 'git', path: '/git' },
    { id: 'remote::/remote', repoId: 'remote', path: '/remote' }
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
    // A same-path workspace on another host is never the one a local save checks out.
    await expect(
      perforceTargetForFile(context('git::/git', '/git'), '/remote/a.cs')
    ).resolves.toBeNull()
  })

  it("checks out a twin workspace's file on the host the save runs on", async () => {
    store.repos.push(
      repo('p4', { path: '/ws', kind: 'folder', vcs: 'perforce', executionHostId: 'runtime:box' })
    )
    store.worktrees.push({ id: 'p4::/ws', repoId: 'p4', path: '/ws', hostId: 'runtime:box' })
    const onBox = {
      ...context('git::/git', '/git'),
      target: { kind: 'environment' as const, environmentId: 'box' }
    }
    await expect(perforceTargetForFile(onBox, '/ws/a.cs')).resolves.toMatchObject({
      worktreeId: 'p4::/ws',
      target: { kind: 'environment', environmentId: 'box' }
    })
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

describe('perforceProjectTarget', () => {
  it('routes a project whose id repeats across hosts to the host named by hostId', () => {
    store.repos = [
      repo('p4', { kind: 'folder', vcs: 'perforce' }),
      repo('p4', { kind: 'folder', vcs: 'perforce', executionHostId: 'runtime:box' })
    ]
    expect(perforceProjectTarget('p4', 'runtime:box').target).toEqual({
      kind: 'environment',
      environmentId: 'box'
    })
  })
})
