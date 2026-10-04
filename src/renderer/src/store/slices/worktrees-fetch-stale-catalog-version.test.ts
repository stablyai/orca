import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorktreeCatalogVersion } from '../../../../shared/worktree/catalog-version'
import { acquireDirectSshDetectedWorktreeRefresh } from './worktrees'
import {
  TEST_SSH_AUTHORITY,
  makeDetectedResult,
  qualifyDetectedResult
} from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { worktreeCatalogVersionKey } from './worktrees/listing/worktree-catalog-version-state'
import { completeSameIdHostScopedRemoval } from './worktrees/teardown/host-qualified-worktree-removal'
import { applyCreatedWorktree } from './worktrees/create/created-worktree-state-merge'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

// Why reset, not clear: a queued one-shot listing an earlier case left unconsumed must not leak.
beforeEach(() => {
  mockApi.worktrees.listDetected.mockReset()
})

const HOST = 'host-epoch'
const APPLIED_BY_CREATE: WorktreeCatalogVersion = { epoch: HOST, sequence: 7 }

function seed(store: ReturnType<typeof createTestStore>) {
  const created = makeWorktree({
    id: 'repo1::/path/created',
    repoId: 'repo1',
    path: '/path/created'
  })
  const surviving = makeWorktree({
    id: 'repo1::/path/surviving',
    repoId: 'repo1',
    path: '/path/surviving'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture tabs carry only the fields the purge and teardown paths read.
  store.setState({
    repos: [
      { id: 'repo1', path: '/path/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: { repo1: [created, surviving] },
    detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [created, surviving]) },
    tabsByWorktree: { [created.id]: [{ id: 'tab-created', worktreeId: created.id }] },
    // The create reply that produced `created` has been applied at sequence 7.
    worktreeCatalogVersionByRepoHost: {
      [worktreeCatalogVersionKey('repo1', 'local')]: APPLIED_BY_CREATE
    }
  } as unknown as Partial<AppState>)
  return { created, surviving }
}

// Why this suite exists: the teardown RPC runs before the merge, so a listing the merge would
// refuse must be refused before it stops any terminals, judged against the live applied version.
describe('fetchWorktrees with a listing versioned before an applied create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  it("neither tears down the created worktree's terminals nor purges it, then lists again", async () => {
    const store = createTestStore()
    const { created, surviving } = seed(store)
    mockApi.worktrees.listDetected
      .mockImplementationOnce(async (args) =>
        qualifyDetectedResult(
          args,
          makeDetectedResult('repo1', [surviving], { catalogVersion: { epoch: HOST, sequence: 6 } })
        )
      )
      .mockImplementationOnce(async (args) =>
        qualifyDetectedResult(
          args,
          makeDetectedResult('repo1', [created, surviving], {
            catalogVersion: { epoch: HOST, sequence: 7 }
          })
        )
      )

    await expect(store.getState().fetchWorktrees('repo1')).resolves.toBe(true)

    expect(mockApi.runtime.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.teardownMissingTerminals' })
    )
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([
      created.id,
      surviving.id
    ])
    expect(store.getState().tabsByWorktree[created.id]).toBeDefined()
    // Why: the refused listing may be the caller's only answer (a change event that joined it), so
    // one listing follows, and it scans at or past the applied version.
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
    expect(
      store.getState().worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey('repo1', 'local')]
    ).toBe(APPLIED_BY_CREATE)
  })

  it('lists again at most once, even when the second listing is also stale', async () => {
    const store = createTestStore()
    const { created, surviving } = seed(store)
    const staleListing = async (args: Parameters<typeof qualifyDetectedResult>[0]) =>
      qualifyDetectedResult(
        args,
        makeDetectedResult('repo1', [surviving], { catalogVersion: { epoch: HOST, sequence: 6 } })
      )
    mockApi.worktrees.listDetected
      .mockImplementationOnce(staleListing)
      .mockImplementationOnce(staleListing)
      .mockImplementationOnce(async (args) =>
        qualifyDetectedResult(
          args,
          makeDetectedResult('repo1', [created, surviving], {
            catalogVersion: { epoch: HOST, sequence: 7 }
          })
        )
      )

    await expect(store.getState().fetchWorktrees('repo1')).resolves.toBe(false)

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([
      created.id,
      surviving.id
    ])
  })

  // Why both: the startup hydration pass and later refreshes list through separate call sites.
  it.each([true, false])(
    'fetchAllWorktrees neither tears down nor purges on a listing older than the create (hydrated purge: %s)',
    async (hasHydratedWorktreePurge) => {
      const store = createTestStore()
      const { created, surviving } = seed(store)
      store.setState({ hasHydratedWorktreePurge })
      mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
        qualifyDetectedResult(
          args,
          makeDetectedResult('repo1', [surviving], { catalogVersion: { epoch: HOST, sequence: 6 } })
        )
      )

      await store.getState().fetchAllWorktrees()

      expect(mockApi.worktrees.listDetected).toHaveBeenCalledOnce()
      expect(mockApi.runtime.call).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.teardownMissingTerminals' })
      )
      expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([
        created.id,
        surviving.id
      ])
    }
  )

  it("a paired runtime's listing older than the create stops no terminals", async () => {
    const store = createTestStore()
    const runtimeHost = 'runtime:env-1'
    const created = makeWorktree({ id: 'repo1::/r/created', repoId: 'repo1', hostId: runtimeHost })
    const surviving = makeWorktree({
      id: 'repo1::/r/surviving',
      repoId: 'repo1',
      hostId: runtimeHost
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture settings carry only the field runtime routing reads.
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'repo1',
          path: '/r/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: runtimeHost
        }
      ],
      worktreesByRepo: { repo1: [created, surviving] },
      worktreeCatalogVersionByRepoHost: {
        [worktreeCatalogVersionKey('repo1', runtimeHost)]: APPLIED_BY_CREATE
      }
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(async ({ method }: { method: string }) => ({
      id: 'rpc',
      ok: true,
      result:
        method === 'worktree.detectedList'
          ? makeDetectedResult('repo1', [surviving], {
              catalogVersion: { epoch: HOST, sequence: 6 }
            })
          : {},
      _meta: { runtimeId: 'runtime-remote' }
    }))

    await store.getState().fetchWorktrees('repo1')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.detectedList' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.teardownMissingTerminals' })
    )
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([
      created.id,
      surviving.id
    ])
  })

  it('control: a listing versioned after the create tears down and purges as before', async () => {
    const store = createTestStore()
    const { created, surviving } = seed(store)
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(
        args,
        makeDetectedResult('repo1', [surviving], { catalogVersion: { epoch: HOST, sequence: 8 } })
      )
    )

    await store.getState().fetchWorktrees('repo1')

    expect(mockApi.runtime.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.teardownMissingTerminals',
        params: expect.objectContaining({ repo: 'repo1', worktreeIds: [created.id] })
      })
    )
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([surviving.id])
    expect(
      store.getState().worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey('repo1', 'local')]
    ).toEqual({ epoch: HOST, sequence: 8 })
  })
})

// Why this suite exists: absence from a listing is how a client learns of a delete, so presence
// in one is how a removed row comes back. The removal reply's version must be on record before a
// listing scanned ahead of the removal can land.
describe('a listing versioned before an applied removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  it('does not bring the removed worktree back', async () => {
    const store = createTestStore()
    const { created, surviving } = seed(store)
    mockApi.worktrees.remove.mockResolvedValueOnce({
      catalogVersion: { epoch: HOST, sequence: 9 }
    })

    await store.getState().removeWorktree({ id: created.id, executionHostId: null })
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([surviving.id])

    mockApi.worktrees.listDetected.mockImplementation(async (args) =>
      qualifyDetectedResult(
        args,
        makeDetectedResult('repo1', [created, surviving], {
          catalogVersion: { epoch: HOST, sequence: 8 }
        })
      )
    )
    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([surviving.id])
  })
})

describe('catalog version bookkeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  it('a repeated listing at the applied version changes no state', async () => {
    const store = createTestStore()
    const { created, surviving } = seed(store)
    mockApi.worktrees.listDetected.mockImplementation(async (args) =>
      qualifyDetectedResult(
        args,
        makeDetectedResult('repo1', [created, surviving], {
          catalogVersion: { epoch: HOST, sequence: 7 }
        })
      )
    )
    await store.getState().fetchWorktrees('repo1')
    const settled = store.getState()

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState()).toBe(settled)
  })

  it('a version this client cannot order is treated as unstamped', async () => {
    const store = createTestStore()
    const { surviving } = seed(store)
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, {
        ...makeDetectedResult('repo1', [surviving]),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a host publishing a shape this client does not know.
        catalogVersion: { epoch: HOST, sequence: '9' } as unknown as WorktreeCatalogVersion
      })
    )

    await store.getState().fetchWorktrees('repo1')

    // Unstamped listings keep the pre-version behavior: applied, and nothing recorded.
    expect(store.getState().worktreesByRepo.repo1?.map((w) => w.id)).toEqual([surviving.id])
    expect(
      store.getState().worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey('repo1', 'local')]
    ).toBe(APPLIED_BY_CREATE)
  })
})

describe('a removal on one of two hosts that share a worktree id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  it("records the removal's version for the removed host", async () => {
    const store = createTestStore()
    const { created } = seed(store)
    const removedVersion = { epoch: 'ssh-host-epoch', sequence: 4 }

    await completeSameIdHostScopedRemoval({
      set: store.setState,
      get: store.getState,
      worktreeId: created.id,
      requiredExecutionHostId: 'ssh:ssh-1',
      removalResult: { catalogVersion: removedVersion },
      removalRoute: null,
      target: { kind: 'local' },
      worktreeBeforeRemoval: created,
      suppressPreservedBranchToast: true,
      rowAlreadyDropped: true
    })

    const versions = store.getState().worktreeCatalogVersionByRepoHost
    expect(versions[worktreeCatalogVersionKey('repo1', 'ssh:ssh-1')]).toEqual(removedVersion)
    expect(versions[worktreeCatalogVersionKey('repo1', 'local')]).toBe(APPLIED_BY_CREATE)
  })
})

// Why this suite exists: the one-shot startup purge keeps only ids from the scanned rows, read
// after every repo's listing settled. A create landing in between writes only the visible rows,
// so without deferral the purge closes the new workspace's tabs, its chat tab included.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture tabs carry only the fields the purge reads.
    store.setState({
      repos: [
        { id: 'repo1', path: '/path/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 },
        { id: 'repo2', path: '/path/repo2', displayName: 'Repo 2', badgeColor: '#000', addedAt: 0 }
      ],
      tabsByWorktree: { [zombieId]: [{ id: 'tab-zombie', worktreeId: zombieId }] }
    } as unknown as Partial<AppState>)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture tabs carry only the fields the purge reads.
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [created.id]: [{ id: 'tab-created', worktreeId: created.id }]
      }
    } as unknown as Partial<AppState>)
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

  it('defers when a listing is refused because its repo owner changed while it was in flight', async () => {
    const store = createTestStore()
    const surviving = makeWorktree({ id: 'repo1::/path/surviving', repoId: 'repo1' })
    const zombieId = 'repo1::/path/deleted-last-session'
    const repo1 = {
      id: 'repo1',
      path: '/path/repo1',
      displayName: 'Repo 1',
      badgeColor: '#000',
      addedAt: 0
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture tabs carry only the fields the purge reads.
    store.setState({
      repos: [repo1],
      tabsByWorktree: { [zombieId]: [{ id: 'tab-zombie', worktreeId: zombieId }] }
    } as unknown as Partial<AppState>)
    mockApi.worktrees.listDetected.mockImplementation(async (args) => {
      // A second owner on the same host makes the listing's owner ambiguous by the time it lands.
      store.setState({ repos: [repo1, { ...repo1 }] })
      return qualifyDetectedResult(args, makeDetectedResult('repo1', [surviving]))
    })

    await store.getState().fetchAllWorktrees()

    expect(store.getState().tabsByWorktree[zombieId]).toBeDefined()
    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
  })
})

// Why this suite exists: the SSH reconnect preparation ends on any repo reporting 'stale' and
// skips its post-connect workspace sync, which nothing retries while the connection holds.
describe('a direct SSH listing older than an applied create', () => {
  const sshHost = 'ssh:ssh-1'

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    resetWorktreeSliceModuleMemory()
  })

  function seedSsh(store: ReturnType<typeof createTestStore>) {
    const created = makeWorktree({
      id: 'repo-ssh::/home/orca/created',
      repoId: 'repo-ssh',
      path: '/home/orca/created',
      hostId: sshHost
    })
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { 'repo-ssh': [created] },
      worktreeCatalogVersionByRepoHost: {
        [worktreeCatalogVersionKey('repo-ssh', sshHost)]: APPLIED_BY_CREATE
      }
    })
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(
        args,
        makeDetectedResult('repo-ssh', [], { catalogVersion: { epoch: HOST, sequence: 6 } })
      )
    )
    return created
  }

  it('is not applied, and reports the repo current rather than stale', async () => {
    const store = createTestStore()
    const created = seedSsh(store)
    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: sshHost,
      authority: TEST_SSH_AUTHORITY
    })
    const providerResult = await lease.result

    expect(lease.merge(providerResult)).toBe(providerResult)
    expect(store.getState().worktreesByRepo['repo-ssh']?.map((w) => w.id)).toEqual([created.id])
  })

  it('a direct-authority fetchWorktrees caller gets the same report, without a relist', async () => {
    const store = createTestStore()
    const created = seedSsh(store)

    await expect(
      store.getState().fetchWorktrees('repo-ssh', {
        executionHostId: sshHost,
        directSshAuthority: TEST_SSH_AUTHORITY
      })
    ).resolves.toMatchObject({ status: 'complete' })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledOnce()
    expect(store.getState().worktreesByRepo['repo-ssh']?.map((w) => w.id)).toEqual([created.id])
  })

  it('still reports stale when the repo owner went away during the listing, though it is also older', async () => {
    const store = createTestStore()
    seedSsh(store)
    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: sshHost,
      authority: TEST_SSH_AUTHORITY
    })
    const providerResult = await lease.result
    store.setState({ repos: [] })

    expect(lease.merge(providerResult)).toMatchObject({ status: 'stale' })
  })

  it('control: still reports stale when the connection moved during the listing', async () => {
    const store = createTestStore()
    seedSsh(store)
    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: sshHost,
      authority: TEST_SSH_AUTHORITY
    })
    const providerResult = await lease.result
    store.setState({
      sshConnectionStates: new Map([
        [
          TEST_SSH_AUTHORITY.targetId,
          {
            targetId: TEST_SSH_AUTHORITY.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: TEST_SSH_AUTHORITY.providerEpoch,
            connectionGeneration: TEST_SSH_AUTHORITY.connectionGeneration + 1
          }
        ]
      ])
    })

    expect(lease.merge(providerResult)).toMatchObject({ status: 'stale' })
  })
})
