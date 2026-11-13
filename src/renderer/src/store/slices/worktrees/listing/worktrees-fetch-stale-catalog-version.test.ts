import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCatalogVersion } from '../../../../../../shared/worktree/catalog-version'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeTerminalTab } from '../../../terminals/terminal-row.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { worktreeCatalogVersionKey } from './worktree-catalog-version-state'
import '../teardown/host-qualified-worktree-removal'
import { applyCreatedWorktree } from '../create/created-worktree-state-merge'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

// Why reset, not clear: a queued one-shot listing an earlier case left unconsumed must not leak.
beforeEach(() => {
  mockApi.worktrees.listDetected.mockReset()
})

const HOST = 'host-epoch'
const APPLIED_BY_CREATE: WorktreeCatalogVersion = { epoch: HOST, sequence: 7 }

// Defer startup purge if create overtakes listing; scanned rows omit the new workspace and would close its terminal/chat tabs.
describe('the startup hydration purge behind a listing that is no longer current', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  it("defers instead of closing the created workspace's tabs, then purges once listings catch up", async () => {
    const store = createTestStore()
    const surviving = makeWorktree({ id: 'repo1::/path/surviving', repoId: 'repo1' })
    const created = makeWorktree({ id: 'repo1::/path/created', repoId: 'repo1' })
    const other = makeWorktree({ id: 'repo2::/path/other', repoId: 'repo2' })
    const zombieId = 'repo1::/path/deleted-last-session'
    store.setState({
      repos: [
        { id: 'repo1', path: '/path/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 },
        { id: 'repo2', path: '/path/repo2', displayName: 'Repo 2', badgeColor: '#000', addedAt: 0 }
      ],
      tabsByWorktree: { [zombieId]: [makeTerminalTab({ id: 'tab-zombie', worktreeId: zombieId })] }
    })
    let releaseRepo2: () => void = () => {}
    const repo2Held = new Promise<void>((resolve) => {
      releaseRepo2 = resolve
    })
    mockApi.worktrees.listDetected.mockImplementation(async (args) => {
      if (args.repoId === 'repo2') {
        await repo2Held
        return qualifyDetectedResult(args, makeDetectedResult('repo2', [other]))
      }
      return qualifyDetectedResult(
        args,
        makeDetectedResult('repo1', [surviving], { catalogVersion: { epoch: HOST, sequence: 6 } })
      )
    })

    const startup = store.getState().fetchAllWorktrees()
    await vi.waitFor(() =>
      expect(
        store.getState().worktreeCatalogVersionByRepoHost[
          worktreeCatalogVersionKey('repo1', 'local')
        ]
      ).toEqual({ epoch: HOST, sequence: 6 })
    )
    // The create reply lands, then the requested chat tab opens, while repo2 is still listing.
    applyCreatedWorktree(store.setState, 'repo1', {
      worktree: created,
      catalogVersion: APPLIED_BY_CREATE
    })
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [created.id]: [makeTerminalTab({ id: 'tab-created', worktreeId: created.id })]
      }
    })
    releaseRepo2()
    await startup

    expect(store.getState().tabsByWorktree[created.id]).toBeDefined()
    expect(store.getState().hasHydratedWorktreePurge).toBe(false)

    mockApi.worktrees.listDetected.mockImplementation(async (args) =>
      qualifyDetectedResult(
        args,
        args.repoId === 'repo2'
          ? makeDetectedResult('repo2', [other])
          : makeDetectedResult('repo1', [surviving, created], { catalogVersion: APPLIED_BY_CREATE })
      )
    )
    await store.getState().fetchAllWorktrees()

    expect(store.getState().tabsByWorktree[created.id]).toBeDefined()
    expect(store.getState().tabsByWorktree[zombieId]).toBeUndefined()
    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
  })
})
