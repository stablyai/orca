import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../src/shared/pairing'
import { normalizeWorktreeLinkedItemMetadata } from '../../src/main/persistence/tracking-repos/worktree-metadata-normalization'
import { getLocalProjectWorktreeGitOptions } from '../../src/main/project-runtime-git-options'
import { resolveCommand } from '../../src/main/git/command-runner/wsl-command-resolution'
import { listWorktreesStrict } from '../../src/main/git/worktree-listing'
import * as sparseState from '../../src/main/git/worktree-sparse-state'
import {
  __resetSparseCheckoutStateCacheForTests,
  onSparseCheckoutStateChanged
} from '../../src/main/git/worktree-sparse-checkout-cache'

vi.mock('../../src/main/wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => undefined
}))
import { OrcaRuntimeWithListManagedWorktrees } from '../../src/main/runtime/orca-runtime-list-managed-worktrees'
import { runProcess } from '../../src/shared/child-process/run-process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, devNull } from 'node:os'
import { mergeWorktree } from '../../src/main/ipc/worktree-metadata-merge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManagedWorktreeQueries } from '../../src/main/runtime/runtime-managed-worktree-queries'
import { listWorktreeInventory } from '../../src/main/runtime/runtime-managed-worktree-inventory'
import { MetadataLineageOperations } from '../../src/main/persistence/loading-store/metadata-lineage-operations'
import type { PersistedState } from '../../src/shared/persisted-state-types'
import type { RuntimeStore } from '../../src/main/runtime/runtime-store-contract'
import type { Repo } from '../../src/shared/repo-types'
import type { RuntimeWorktreeScanResult } from '../../src/main/runtime/repo-worktree-resolution-scan'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { WORKTREE_CATALOG_METHODS } from '../../src/main/runtime/rpc/methods/worktree-catalog-methods'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient } from '../../src/cli/runtime-client'

const request = {
  repo: 'id:repo-1',
  repoPath: '/source/app',
  projectId: 'project-1',
  hostId: 'local' as const
}
const git = {
  path: '/source/hidden',
  branch: 'refs/heads/hidden',
  head: 'abc',
  isBare: false,
  isMainWorktree: false
}

function fixture() {
  const repo: Repo = {
    id: 'repo-1',
    path: request.repoPath,
    displayName: 'App',
    badgeColor: '#000',
    addedAt: 1,
    externalWorktreeVisibility: 'hide'
  }
  const state = {
    worktreeMeta: {},
    worktreeMetaByIdentity: {},
    worktreeIdentityAliases: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {}
  } as unknown as PersistedState
  const scheduling = { scheduleSave: vi.fn() }
  const metadata = new MetadataLineageOperations({ state }, scheduling as never, {} as never)
  const projects = [{ id: request.projectId, sourceRepoIds: [repo.id] }]
  const setups = [
    {
      id: 'setup-1',
      projectId: request.projectId,
      hostId: 'local',
      repoId: repo.id,
      path: repo.path,
      setupState: 'ready'
    }
  ]
  state.projects = projects as never
  state.projectHostSetups = setups as never
  const settings = {
    workspaceDir: '/worktrees',
    nestWorkspaces: true,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    localWindowsRuntimeDefault: { kind: 'windows-host' } as
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string | null },
    refreshLocalBaseRefOnWorktreeCreate: false
  }
  const store = {
    getRepos: () => [repo],
    getRepo: () => repo,
    getProjects: () => projects,
    getProjectHostSetups: () => setups,
    getSettings: () => settings,
    getAllWorktreeMeta: () => state.worktreeMeta,
    getWorktreeMeta: (id: string) => state.worktreeMeta[id],
    getWorktreeInventoryRecords: (
      ...args: Parameters<MetadataLineageOperations['getWorktreeInventoryRecords']>
    ) => metadata.getWorktreeInventoryRecords(...args)
  } as unknown as RuntimeStore
  const scan = vi
    .fn<() => Promise<RuntimeWorktreeScanResult>>()
    .mockResolvedValue({ ok: true, worktrees: [git] })
  const queries = new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => [mergeWorktree(repo.id, git, undefined)] as never,
    resolveRepo: async () => repo,
    selectRepos: () => [repo],
    listKnownHostIds: () => ['local'],
    scanRepo: scan
  })
  const inventory = (params = request) => listWorktreeInventory(store, params, scan)
  const runtime = {
    getRuntimeId: () => 'fixture-runtime',
    inventoryManagedWorktrees: inventory
  } as unknown as OrcaRuntimeService
  const rpc = new RpcDispatcher({ runtime, methods: WORKTREE_CATALOG_METHODS })
  return {
    repo,
    state,
    scheduling,
    projects,
    setups,
    settings,
    store,
    scan,
    queries,
    inventory,
    rpc
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('public worktree inventory', () => {
  it('includes hidden Git worktrees without changing visibility', async () => {
    const f = fixture()
    const before = JSON.stringify(f.state)
    const result = await f.inventory()
    expect(result).toMatchObject({
      authoritative: true,
      truncated: false,
      scope: { ...request, repoId: 'repo-1', projectHostSetupId: 'setup-1' }
    })
    expect(result.worktrees[0]).toMatchObject({
      id: 'repo-1::/source/hidden',
      path: git.path,
      branch: git.branch,
      visible: false
    })
    expect(JSON.stringify(f.state)).toBe(before)
    expect(f.repo.externalWorktreeVisibility).toBe('hide')
    expect(f.scheduling.scheduleSave).not.toHaveBeenCalled()
  })

  it('preserves metadata after the Git checkout disappears', async () => {
    const f = fixture()
    f.state.worktreeMeta['repo-1::/gone'] = {
      hostId: 'local',
      projectId: request.projectId,
      instanceId: 'residual'
    } as never
    f.scan.mockResolvedValue({ ok: true, worktrees: [] })
    const before = JSON.stringify(f.state)
    const result = await f.inventory()
    expect(result.records).toContainEqual(
      expect.objectContaining({
        source: 'legacy-metadata',
        worktreeId: 'repo-1::/gone',
        instanceId: 'residual'
      })
    )
    expect(JSON.stringify(f.state)).toBe(before)
    expect(result.totalCount).toBeGreaterThan(0)
  })

  it('distinguishes complete empty from failed and fallback scans', async () => {
    const f = fixture()
    f.scan
      .mockResolvedValueOnce({ ok: true, worktrees: [] })
      .mockResolvedValueOnce({ ok: false, worktrees: [git] })
      .mockRejectedValueOnce(new Error('offline'))
    expect(await f.inventory()).toMatchObject({
      authoritative: true,
      totalCount: 0,
      failureReasons: []
    })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['scan_failed'],
      worktrees: []
    })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['scan_failed']
    })
  })

  it.each([
    { hostId: 'ssh:offline' },
    { hostId: 'runtime:offline' },
    { projectId: 'wrong' },
    { repoPath: '/wrong' },
    { repo: 'id:wrong' }
  ])('refuses divergent scope before scanning: %j', async (change) => {
    const f = fixture()
    const result = await f.inventory({ ...request, ...change } as typeof request)
    expect(result.authoritative).toBe(false)
    expect(f.scan).not.toHaveBeenCalled()
  })

  it('refuses folder workspaces and off-host repos without local fallback', async () => {
    const f = fixture()
    f.repo.kind = 'folder'
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['unsupported_workspace']
    })
    f.repo.kind = 'git'
    f.repo.executionHostId = 'ssh:offline'
    expect(await f.inventory()).toMatchObject({ authoritative: false })
    expect(f.scan).not.toHaveBeenCalled()
  })

  it('refuses ambiguous setup and changed scope across the scan', async () => {
    const f = fixture()
    f.setups.push({ ...f.setups[0], id: 'duplicate' })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['scope_mismatch']
    })
    f.setups.pop()
    f.scan.mockImplementation(async () => {
      f.setups[0].path = '/moved'
      return { ok: true, worktrees: [] }
    })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['scope_changed']
    })
  })

  it('refuses metadata changes during the scan', async () => {
    const f = fixture()
    f.scan.mockImplementation(async () => {
      f.state.worktreeMeta['repo-1::/new'] = { hostId: 'local' } as never
      return { ok: true, worktrees: [] }
    })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['records_changed']
    })
  })

  it('runs the CLI dispatch, RPC schema/handler and service together', async () => {
    const f = fixture()
    const client = {
      call: async (method: string, params: unknown) =>
        f.rpc.dispatch({ id: '1', authToken: 'fixture', method, params })
    } as unknown as RuntimeClient
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dispatch(['worktree', 'inventory'], {
      client,
      cwd: '/unrelated',
      json: true,
      flags: new Map([
        ['repo', request.repo],
        ['repo-path', request.repoPath],
        ['project', request.projectId],
        ['host', request.hostId]
      ])
    })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      ok: true,
      result: { authoritative: true, worktrees: [expect.objectContaining({ visible: false })] }
    })
  })

  it.each([{ limit: 1 }, { cursor: 'next' }, { projectId: undefined }, { hostId: undefined }])(
    'RPC refuses partial/implicit requests: %j',
    async (change) => {
      const f = fixture()
      const result = await f.rpc.dispatch({
        id: '1',
        authToken: 'fixture',
        method: 'worktree.inventory',
        params: { ...request, ...change }
      })
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(f.scan).not.toHaveBeenCalled()
    }
  )

  it('old servers fail explicitly instead of falling back to list', async () => {
    const f = fixture()
    const rpc = new RpcDispatcher({
      runtime: { getRuntimeId: () => 'old' } as OrcaRuntimeService,
      methods: WORKTREE_CATALOG_METHODS.filter((method) => method.name !== 'worktree.inventory')
    })
    expect(
      await rpc.dispatch({
        id: '1',
        authToken: 'fixture',
        method: 'worktree.inventory',
        params: request
      })
    ).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(f.scan).not.toHaveBeenCalled()
  })
  it('default list still hides the same external worktree', async () => {
    const f = fixture()
    expect(await f.queries.list(request.repo, 100)).toMatchObject({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
    expect((await f.inventory()).worktrees).toHaveLength(1)
  })

  it('runtime entrypoint reads fresh real Git, including preparations, and retains deleted checkout records', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', devNull)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const root = mkdtempSync(join(tmpdir(), 'inventory-git-'))
    const repoPath = join(root, 'repo')
    const hidden = join(root, 'hidden')
    mkdirSync(repoPath)
    const gitCommand = async (...args: string[]) => {
      const result = await runProcess({
        program: 'git',
        args: ['-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args],
        cwd: repoPath,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull }
      })
      expect(result.code, result.stderr).toBe(0)
    }
    try {
      await gitCommand('init')
      await gitCommand(
        '-c',
        'user.name=Inventory Test',
        '-c',
        'user.email=inventory@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'fixture'
      )
      await gitCommand('worktree', 'add', '-b', 'hidden', hidden)
      await gitCommand(
        'worktree',
        'lock',
        '--reason',
        'orca-create-preparation:v1:123:fixture',
        hidden
      )
      const f = fixture()
      f.repo.path = repoPath
      f.setups[0].path = repoPath
      const params = { ...request, repoPath }
      const runtime = { managedWorktreeQueries: f.queries, requireStore: () => f.store }
      const inventory = () =>
        OrcaRuntimeWithListManagedWorktrees.prototype.inventoryManagedWorktrees.call(
          runtime as never,
          params
        )
      __resetSparseCheckoutStateCacheForTests()
      const listener = vi.fn()
      onSparseCheckoutStateChanged(listener)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const detect = vi.spyOn(sparseState, 'detectSparseCheckout').mockResolvedValue(false)
      await listWorktreesStrict(repoPath, { includeCreatePreparations: true })
      detect.mockClear().mockResolvedValue(true)
      clock.mockReturnValue(1_000 + 5 * 60_000 + 1)
      const present = await inventory()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listener).not.toHaveBeenCalled()
      expect(detect).not.toHaveBeenCalled()
      // The stale-cache control must still notify through the legacy scanner.
      await listWorktreesStrict(repoPath, { includeCreatePreparations: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listener).toHaveBeenCalledWith(repoPath, hidden, true)
      clock.mockRestore()
      detect.mockRestore()
      __resetSparseCheckoutStateCacheForTests()
      expect(present).toMatchObject({ authoritative: true })
      expect(present.worktrees).toContainEqual(
        expect.objectContaining({ path: hidden, visible: false })
      )
      await gitCommand('worktree', 'unlock', hidden)
      f.state.worktreeMeta[`repo-1::${hidden}`] = {
        hostId: 'local',
        instanceId: 'residual'
      } as never
      await gitCommand('worktree', 'remove', hidden)
      const before = JSON.stringify(f.state)
      const removed = await inventory()
      expect(removed.worktrees.some((row) => row.path === hidden)).toBe(false)
      expect(removed.records).toContainEqual(
        expect.objectContaining({ worktreeId: `repo-1::${hidden}`, instanceId: 'residual' })
      )
      expect(JSON.stringify(f.state)).toBe(before)
      rmSync(join(repoPath, '.git'), { recursive: true })
      expect(await inventory()).toMatchObject({
        authoritative: false,
        failureReasons: ['scan_failed']
      })
    } finally {
      __resetSparseCheckoutStateCacheForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('does not impose the legacy list limit on inventory', async () => {
    const f = fixture()
    f.scan.mockResolvedValue({
      ok: true,
      worktrees: Array.from({ length: 1001 }, (_, index) => ({
        ...git,
        path: `/source/hidden-${index}`
      }))
    })
    expect(await f.inventory()).toMatchObject({
      authoritative: true,
      totalCount: 1001,
      truncated: false
    })
  })

  it('missing record accessor and metadata read failure never become empty authority', async () => {
    const f = fixture()
    f.store.getWorktreeInventoryRecords = undefined
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['records_unavailable']
    })
    f.store.getWorktreeInventoryRecords = () => {
      throw new Error('metadata unavailable')
    }
    expect(
      await f.rpc.dispatch({
        id: '1',
        authToken: 'fixture',
        method: 'worktree.inventory',
        params: request
      })
    ).toMatchObject({ ok: false })
  })

  it.each([
    ['host', 'ssh:offline'],
    ['environment', 'remote'],
    ['pairing-code', 'remote']
  ])('CLI refuses remote selector %s without inventory RPC', async (flag, value) => {
    const client = { call: vi.fn() } as unknown as RuntimeClient
    await expect(
      dispatch(['worktree', 'inventory'], {
        client,
        cwd: '/unrelated',
        json: true,
        flags: new Map([
          ['repo', request.repo],
          ['repo-path', request.repoPath],
          ['project', request.projectId],
          ['host', 'local'],
          [flag, value]
        ])
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(client.call).not.toHaveBeenCalled()
  })
  it('rejects a second setup for the same project and host on another repo', async () => {
    const f = fixture()
    f.setups.push({ ...f.setups[0], id: 'wrong-repo', repoId: 'other' })
    expect(await f.inventory()).toMatchObject({
      authoritative: false,
      failureReasons: ['scope_mismatch']
    })
    expect(f.scan).not.toHaveBeenCalled()
  })
})

describe('inventory execution and ownership boundaries', () => {
  it.each([false, true])(
    'rejects effective legacy pairing before RPC, env removed after construction: %s',
    async (clearSelection) => {
      vi.stubEnv('ORCA_ENVIRONMENT', undefined)
      vi.stubEnv('ORCA_PAIRING_CODE', undefined)
      vi.stubEnv(
        'ORCA_REMOTE_PAIRING',
        encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://inventory.invalid',
          deviceToken: 'synthetic-token',
          publicKeyB64: 'synthetic-key',
          scope: 'runtime'
        })
      )
      const client = new RuntimeClient(join(tmpdir(), 'inventory-unused-profile'))
      expect(client.isRemote).toBe(true)
      if (clearSelection) {
        vi.stubEnv('ORCA_REMOTE_PAIRING', undefined)
      }
      const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('RPC must not be reached'))
      await expect(
        dispatch(['worktree', 'inventory'], {
          client,
          cwd: '/unrelated',
          json: true,
          flags: new Map([
            ['repo', request.repo],
            ['repo-path', request.repoPath],
            ['project', request.projectId],
            ['host', 'local']
          ])
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('retains normalized local canonical evidence with a remote alias and refuses empty authority', async () => {
    const f = fixture()
    f.state.worktreeMetaByIdentity = {
      'wt2:local:occupant': {
        hostId: 'local',
        instanceId: 'occupant',
        projectId: request.projectId,
        projectHostSetupId: 'setup-1'
      }
    } as never
    f.state.worktreeIdentityAliases = { 'ssh:remote|repo-1::/gone': ['wt2:local:occupant'] }
    normalizeWorktreeLinkedItemMetadata(f.state)
    const before = JSON.stringify(f.state)
    f.scan.mockResolvedValue({ ok: true, worktrees: [] })
    const result = await f.inventory()
    expect(result).toMatchObject({ authoritative: false, failureReasons: ['records_ambiguous'] })
    expect(result.records).toContainEqual(
      expect.objectContaining({
        sourceKey: 'wt2:local:occupant',
        relatedWorktreeIds: ['repo-1::/gone']
      })
    )
    expect(result.totalCount).toBeGreaterThan(0)
    expect(JSON.stringify(f.state)).toBe(before)
    expect(f.scheduling.scheduleSave).not.toHaveBeenCalled()
  })

  it.each([
    String.raw`\\wsl.localhost\Ubuntu\home\user\repo`,
    String.raw`\\wsl$\Ubuntu\home\user\repo`
  ])('rejects UNC routing before scanner: %s', async (repoPath) => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const f = fixture()
      f.repo.path = f.setups[0].path = repoPath
      expect(getLocalProjectWorktreeGitOptions(f.store as never, f.repo)).toEqual({})
      expect(
        resolveCommand('git', ['worktree', 'list', '--porcelain', '-z'], repoPath)
      ).toMatchObject({ binary: 'wsl.exe', wsl: { distro: 'Ubuntu' } })
      expect(await f.inventory({ ...request, repoPath })).toMatchObject({
        authoritative: false,
        failureReasons: ['unsupported_runtime']
      })
      expect(f.scan).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    }
  })

  it.each(['Ubuntu', null])(
    'invalidates native-to-WSL or repair change during scan, retaining evidence: %s',
    async (distro) => {
      const platform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const f = fixture()
        f.repo.path = f.setups[0].path = String.raw`C:\repo`
        expect(getLocalProjectWorktreeGitOptions(f.store as never, f.repo)).toEqual({})
        f.state.worktreeMeta['repo-1::/retained'] = { hostId: 'local' } as never
        f.scan.mockImplementation(async () => {
          f.settings.localWindowsRuntimeDefault = { kind: 'wsl', distro }
          return { ok: true, worktrees: [git] }
        })
        const result = await f.inventory({ ...request, repoPath: f.repo.path })
        expect(result).toMatchObject({ authoritative: false, failureReasons: ['scope_changed'] })
        expect(result.worktrees).toHaveLength(1)
        expect(result.records).toContainEqual(
          expect.objectContaining({ worktreeId: 'repo-1::/retained' })
        )
        expect(f.scheduling.scheduleSave).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      }
    }
  )
})

it.each([
  { projectId: request.projectId },
  { projectHostSetupId: 'setup-1' },
  { projectId: request.projectId, projectHostSetupId: 'setup-1' }
])(
  'retains canonical ownership declared by project/setup despite another-repo alias: %j',
  async (ownership) => {
    const f = fixture()
    f.state.worktreeMetaByIdentity = {
      'wt2:local:occupant': { hostId: 'local', instanceId: 'occupant', ...ownership }
    } as never
    f.state.worktreeIdentityAliases = { 'local|other::/gone': ['wt2:local:occupant'] }
    normalizeWorktreeLinkedItemMetadata(f.state)
    const before = JSON.stringify(f.state)
    f.scan.mockResolvedValue({ ok: true, worktrees: [] })
    const result = await f.inventory()
    expect(result).toMatchObject({ authoritative: false, failureReasons: ['records_ambiguous'] })
    expect(result.records).toContainEqual(
      expect.objectContaining({
        sourceKey: 'wt2:local:occupant',
        relatedWorktreeIds: ['other::/gone']
      })
    )
    expect(result.records).toContainEqual(
      expect.objectContaining({ source: 'identity-alias', sourceKey: 'local|other::/gone' })
    )
    expect(JSON.stringify(f.state)).toBe(before)
    expect(f.scheduling.scheduleSave).not.toHaveBeenCalled()
  }
)
