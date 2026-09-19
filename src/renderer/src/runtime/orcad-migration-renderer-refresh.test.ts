import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import type { OrcadLiveMigrationRendererPlan } from '../../../shared/orcad-live-migration-renderer-plan'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { refreshOrcadMigrationRenderer } from './orcad-migration-renderer-refresh'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'

const f = vi.hoisted(() => ({
  state: {} as AppState,
  plan: vi.fn(),
  refresh: vi.fn(),
  revision: 1,
  generation: 1
}))
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => f.state,
    setState: (patch: (state: AppState) => Partial<AppState>) => {
      f.state = { ...f.state, ...patch(f.state) }
    }
  }
}))
vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => f.revision
}))
vi.mock('../store/slices/runtime-status', () => ({
  getRuntimeEnvironmentConnectionGeneration: () => f.generation
}))
vi.mock('./web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: f.refresh
}))
const environment = { id: 'env', runtimeId: 'runtime' } as PublicKnownRuntimeEnvironment
const plan: OrcadLiveMigrationRendererPlan = {
  version: 1,
  migrationId: 'migration',
  retirementRecordSha256: 'sha',
  sourceSshTargetId: 'source',
  destinationEnvironmentId: 'env',
  destinationRuntimeId: 'runtime',
  sourceCatalog: { repoIds: ['repo'], projectGroupIds: [], folderWorkspaceIds: [] },
  workspaces: [
    {
      workspaceId: 'workspace',
      terminals: [
        {
          tabId: 'tab',
          leafId: 'leaf',
          sourcePtyId: 'ssh:source:pty',
          incarnationId: 'incarnation'
        }
      ]
    }
  ]
}
const source = { id: 'workspace', hostId: 'ssh:source' }
const destination = { id: 'workspace', hostId: 'local', runtimeOwnerEnvironmentId: 'env' }
const unrelated = { id: 'other', hostId: 'ssh:source' }

beforeEach(() => {
  vi.resetAllMocks()
  f.revision = 1
  f.generation = 1
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { getOrcadLiveMigrationRendererPlan: f.plan } }
  })
  f.plan.mockResolvedValue(structuredClone(plan))
  f.state = {
    repos: [],
    projectHostSetups: [],
    projectGroups: [],
    folderWorkspaces: [],
    worktreesByRepo: { repo: [source, destination, unrelated] },
    detectedWorktreesByRepo: { repo: { worktrees: [source, destination, unrelated] } },
    tabsByWorktree: { workspace: [{ id: 'tab', ptyId: 'ssh:source:pty' }] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    pendingStartupByTabId: {},
    runtimeStatusByEnvironmentId: new Map([['env', { status: { runtimeId: 'runtime' } }]]),
    fetchRepos: vi.fn(),
    fetchProjectGroups: vi.fn(),
    fetchFolderWorkspaces: vi.fn(),
    activeTabId: 'unrelated-active-tab',
    settings: { activeRuntimeEnvironmentId: null }
  } as unknown as AppState
  f.refresh.mockImplementation(async (_env, workspaceId, options) => {
    options.validateSnapshot({
      worktree: workspaceId,
      tabs: [
        {
          type: 'terminal',
          parentTabId: 'tab',
          leafId: 'leaf',
          incarnationId: 'incarnation',
          status: 'ready',
          terminal: 'handle'
        }
      ]
    })
    f.state = {
      ...f.state,
      tabsByWorktree: { workspace: [{ id: 'web-terminal-tab' }] } as never,
      terminalLayoutsByTabId: {
        'web-terminal-tab': { ptyIdsByLeafId: { leaf: toRemoteRuntimePtyId('handle', 'env') } }
      } as never
    }
  })
})

it('waits for canonical mirrors, preserves colliding destination/unrelated rows and never switches servers', async () => {
  const connect = vi.fn().mockResolvedValue(true)
  await expect(refreshOrcadMigrationRenderer(environment, 'migration', connect)).resolves.toBe(true)
  expect(f.plan).toHaveBeenCalledTimes(3)
  expect(f.state.fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
  expect(f.state.fetchProjectGroups).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
  expect(f.state.fetchFolderWorkspaces).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
  expect(f.state.worktreesByRepo.repo).toEqual([destination, unrelated])
  expect(f.state.detectedWorktreesByRepo.repo.worktrees).toEqual([destination, unrelated])
  expect(f.state.activeTabId).toBe('unrelated-active-tab')
  expect(f.state.settings!.activeRuntimeEnvironmentId).toBeNull()
  expect(f.refresh).toHaveBeenCalledWith(
    'env',
    'workspace',
    expect.objectContaining({ afterCurrentInFlight: true, errorMode: 'throw' })
  )
})

it('does not report an unobserved snapshot as ready', async () => {
  f.refresh.mockResolvedValue(undefined)
  await expect(
    refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
  ).rejects.toThrow('snapshot_unverified')
})

it('refuses a newer source process before pruning source listings or requesting mirrors', async () => {
  f.state.tabsByWorktree.workspace[0].ptyId = 'new-process'
  await expect(
    refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
  ).rejects.toThrow('source_identity_changed')
  expect(f.state.worktreesByRepo.repo).toEqual([source, destination, unrelated])
  expect(f.refresh).not.toHaveBeenCalled()
})

it('retires only proven source repo identities preserved by ordinary local refresh', async () => {
  const retired = { id: 'repo', connectionId: 'source' }
  const destination = { id: 'repo', executionHostId: 'runtime:env' }
  const otherHost = { id: 'repo', connectionId: 'other' }
  const otherRepo = { id: 'other', connectionId: 'source' }
  f.state.repos = [retired, destination, otherHost, otherRepo] as never
  const retiredSetup = { id: 'old', repoId: 'repo', hostId: 'ssh:source' }
  const destinationSetup = { id: 'new', repoId: 'repo', hostId: 'runtime:env' }
  const standaloneSetup = { id: 'standalone', hostId: 'ssh:source' }
  const projectedSetup = { ...retiredSetup, id: 'projection', runtimeOwnerEnvironmentId: 'env' }
  f.state.projectHostSetups = [
    retiredSetup,
    destinationSetup,
    standaloneSetup,
    projectedSetup
  ] as never
  await expect(
    refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
  ).resolves.toBe(true)
  expect(f.state.repos).toEqual([destination, otherHost, otherRepo])
  expect(f.state.projectHostSetups).toEqual([destinationSetup, standaloneSetup, projectedSetup])
})

it('refuses catalog fetches that silently failed to remove a captured source group', async () => {
  f.plan.mockResolvedValue({
    ...plan,
    sourceCatalog: { ...plan.sourceCatalog, projectGroupIds: ['group'] }
  })
  f.state.projectGroups = [{ id: 'group', connectionId: 'source' }] as never
  await expect(
    refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
  ).rejects.toThrow('source_catalog_not_refreshed')
  expect(f.refresh).not.toHaveBeenCalled()
})

it('rechecks source bindings after awaiting retirement confirmation before removing repos', async () => {
  const sourceRepo = { id: 'repo', connectionId: 'source' }
  f.state.repos = [sourceRepo] as never
  f.plan.mockResolvedValueOnce(structuredClone(plan)).mockImplementationOnce(async () => {
    f.state.tabsByWorktree.workspace[0].ptyId = 'replacement-process'
    return structuredClone(plan)
  })
  await expect(
    refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
  ).rejects.toThrow('source_identity_changed')
  expect(f.state.repos).toEqual([sourceRepo])
  expect(f.refresh).not.toHaveBeenCalled()
})

it.each(['generation', 'revision', 'retirement'] as const)(
  'refuses changed %s before success',
  async (kind) => {
    f.plan
      .mockImplementationOnce(async () => structuredClone(plan))
      .mockImplementationOnce(async () => {
        if (kind === 'generation') {
          f.generation++
        }
        if (kind === 'revision') {
          f.revision++
        }
        return {
          ...plan,
          retirementRecordSha256: kind === 'retirement' ? 'new' : plan.retirementRecordSha256
        }
      })
    await expect(
      refreshOrcadMigrationRenderer(environment, 'migration', async () => true)
    ).rejects.toThrow(kind === 'retirement' ? 'retirement_changed' : 'destination_changed')
  }
)
