import { describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'

import type { Repo } from '../../../../shared/repo-types'
import '../../../../shared/global-settings-test-fixture'
import '../../web/preload-api/web-fallback-api'
import {
  installReposRuntimeRoutingHarness,
  ptyKill,
  remoteRepo,
  runtimeEnvironmentCall,
  runtimeEnvironmentsList
} from './repo-runtime-routing.test-fixture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

const ownerOf = (repo: Repo) => ({ hostId: getRepoExecutionHostId(repo) })
// Ingest stamps every server row; an unstamped row is this app's own.
const serverRepo: Repo = { ...remoteRepo, executionHostId: 'runtime:env-1' }

describe('repo slice runtime routing', () => {
  it('stops remote runtime terminals instead of killing remote ids through local pty IPC', async () => {
    runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1' }])
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-remote',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [serverRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [
          makeWorktree({ id: worktreeId, repoId: remoteRepo.id, hostId: 'runtime:env-1' })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId } as never]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1', 'pty-local-stale']
      }
    })

    await store.getState().removeProject(remoteRepo.id, ownerOf(serverRepo))

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.stop',
      params: { worktree: `id:${worktreeId}` },
      timeoutMs: 15_000
    })
    expect(ptyKill).toHaveBeenCalledWith('pty-local-stale')
    expect(ptyKill).not.toHaveBeenCalledWith('remote:term-1')
  })
})
