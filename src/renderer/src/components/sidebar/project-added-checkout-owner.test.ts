import { describe, expect, it, vi } from 'vitest'
import { mergeDetectedWorktreesForHost } from '@/store/slices/worktrees/listing/detected-worktree-host-merge'
import {
  mocks,
  makeWorktree,
  makeRepo,
  makeDetectedLinkedWorktrees
} from './project-added-checkout.test-fixture'
import { openProjectDefaultCheckout } from './project-added-default-checkout'

describe('add-project checkout owner', () => {
  it('activates only the captured host default checkout when repo IDs collide', async () => {
    const localMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/local/repo',
      hostId: 'local'
    })
    const runtimeMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/runtime/repo',
      hostId: 'runtime:env-1'
    })
    mocks.state.repos = [
      {
        id: 'repo-1',
        path: '/local/repo',
        displayName: 'local',
        badgeColor: '#111',
        addedAt: 1,
        executionHostId: 'local'
      },
      {
        id: 'repo-1',
        path: '/runtime/repo',
        displayName: 'runtime',
        badgeColor: '#222',
        addedAt: 2,
        executionHostId: 'runtime:env-1'
      }
    ]
    mocks.state.worktreesByRepo = {
      'repo-1': [localMain, runtimeMain]
    }

    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: mocks.state.worktreesByRepo['repo-1'].map((worktree) => ({
          ...worktree,
          ownership: 'external',
          selectedCheckout: worktree.isMainWorktree,
          visible: true
        }))
      }
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it('does not use another host authoritative scan to open a stale loaded checkout', async () => {
    const localMain = makeWorktree({ hostId: 'local' })
    const sshMain = makeWorktree({ hostId: 'ssh:box', path: '/ssh/repo' })
    const failedLocal = mergeDetectedWorktreesForHost(
      makeDetectedLinkedWorktrees(localMain),
      { repoId: 'repo-1', authoritative: false, source: 'git', worktrees: [] },
      'local'
    )
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': mergeDetectedWorktreesForHost(
        failedLocal,
        {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [{ ...sshMain, ownership: 'external', selectedCheckout: true, visible: true }]
        },
        'ssh:box'
      )
    }
    mocks.state.repos = [makeRepo(), makeRepo({ executionHostId: 'ssh:box', path: '/ssh/repo' })]
    mocks.state.worktreesByRepo = { 'repo-1': [localMain] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  })

  it('activates a runtime-owned checkout even when its physical host is private SSH', async () => {
    const runtimeMain = makeWorktree({
      id: 'repo-1::runtime-ssh',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    mocks.state.worktreesByRepo = { 'repo-1': [runtimeMain] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'runtime_server_path',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it('uses the sole repo owner for activation when the caller omits its host', async () => {
    mocks.state.repos = [makeRepo({ executionHostId: 'ssh:box' })]
    mocks.state.worktreesByRepo = { 'repo-1': [makeWorktree({ hostId: 'ssh:box' })] }

    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: mocks.state.worktreesByRepo['repo-1'].map((worktree) => ({
          ...worktree,
          ownership: 'external',
          selectedCheckout: worktree.isMainWorktree,
          visible: true
        }))
      }
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo-1::/repo', {
      executionHostId: 'ssh:box'
    })
  })

  it('does not activate a loaded checkout when its bare repo ID has multiple owners', async () => {
    mocks.state.repos = [makeRepo(), makeRepo({ executionHostId: 'ssh:box' })]
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ hostId: 'local' }), makeWorktree({ hostId: 'ssh:box' })]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  })
})
