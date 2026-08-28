// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { RepositoryForkSyncSection } from './RepositoryForkSyncSection'

const syncRuntimeGitForkDefaultBranch = vi.fn()

vi.mock('../../runtime/runtime-git-client', () => ({
  syncRuntimeGitForkDefaultBranch: (...args: unknown[]) => syncRuntimeGitForkDefaultBranch(...args)
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settingsSearchQuery: '', settings: { activeRuntimeEnvironmentId: 'env-1' } })
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn() })
}))

const RUNTIME_REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo-1',
  displayName: 'repo-1',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git',
  executionHostId: 'runtime:env-1',
  forkSyncMode: 'ask',
  upstream: { owner: 'up', repo: 'r' }
}

describe('RepositoryForkSyncSection', () => {
  afterEach(() => {
    cleanup()
    syncRuntimeGitForkDefaultBranch.mockReset()
  })

  it('syncs a runtime-hosted repo by its main worktree id, not the bare repo id', () => {
    // Why: the runtime rejects `id:<repo-id>` with worktree_id_requires_full_path (#16447).
    syncRuntimeGitForkDefaultBranch.mockResolvedValue({ status: 'up-to-date', behind: 0 })
    render(
      <RepositoryForkSyncSection repo={RUNTIME_REPO} updateRepo={vi.fn()} forceVisible={true} />
    )

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }))

    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'repo-1::/srv/repo-1', worktreePath: '/srv/repo-1' }),
      { owner: 'up', repo: 'r' }
    )
  })
})
