import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getRepoExecutionHostId } from '../../src/shared/execution-host'
import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  createSqliteTestStore,
  writePersistedStateJson
} from '../../src/main/persistence/persistence-test-harness'
import { Store } from '../../src/main/persistence/loading-store/store'
import { getDefaultPersistedState } from '../../src/shared/constants'
import type { Repo } from '../../src/shared/repo-types'
import { projectHostSetupCompatibilityFromRepos } from '../../src/shared/project-host-setup-projection'
import { resolveProjectHostSetupProjection as legacyProjection } from '../../src/shared/project-host-setup-hydration'
import { getProjectHostSetupProjectionFromState } from '../../src/renderer/src/store/project-host-setup-selector'
import { resolveWorktreeMetaWithDiscoveryBackfill } from '../../src/main/ipc/worktrees/listing/worktree-discovery-metadata'
import {
  getProjectHostSetupForRepoHost,
  withRepoHostOwnership
} from '../../src/renderer/src/store/slices/worktrees/listing/worktree-host-ownership'
import { makeWorktree } from '../../src/renderer/src/store/slices/worktrees-slice-test-fixtures'
import { buildAiVaultSessionProjectById } from '../../src/renderer/src/components/right-sidebar/ai-vault-session-projects'
import {
  buildSetupByRepoId,
  resolveActiveProjectKey,
  resolveLegacyActiveProjectKey
} from '../../src/renderer/src/components/right-sidebar/ai-vault-project-key'
import { getProjectHostSetupLookup } from '../../src/shared/project-host-setup-lookup'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../src/shared/endpoint-catalog-adoption'
import { searchHit } from '../../src/shared/ai-vault-search-test-fixture'
import { aiVaultSearchHitToSession } from '../../src/renderer/src/components/right-sidebar/ai-vault-search-session'
import { sessionSearchScopeCatalogFromStore } from '../../src/main/ai-vault-search/session-search-store-scope-catalog'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from '../../src/main/ai-vault-search/session-search-scope-catalog'
import {
  searchSessionService,
  setSessionSearchService
} from '../../src/main/ai-vault-search/session-search-service-registry'
import { createSessionSearchService } from '../../src/main/ai-vault-search/session-search-service'
import {
  openSessionSearchHarness,
  addSyntheticSession,
  type SessionSearchHarness
} from '../../src/main/ai-vault-search/session-search-engine-test-fixture'
import { AiVaultSearchRequestSchema } from '../../src/shared/ai-vault-search-contract'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from '../../src/main/ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from '../../src/main/ai-vault/cached-session-list'
import { parseAiVaultListResult } from '../../src/main/ai-vault/session-list-result-validation'
import {
  restampAiVaultListResult,
  mergeAiVaultListResults
} from '../../src/main/ai-vault/session-list-results'
import { filterAiVaultSessions } from '../../src/shared/ai-vault-session-filters'
import type { AiVaultListResult } from '../../src/shared/ai-vault-types'
import { getLocalWorktreeScanGeneration } from '../../src/main/local-worktree-scan-generation'

const { scanTranscripts } = vi.hoisted(() => ({
  scanTranscripts: vi.fn<() => Promise<AiVaultListResult>>()
}))
vi.mock('../../src/main/ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: scanTranscripts
}))
vi.mock('../../src/main/claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))
vi.mock('../../src/main/ai-vault/opencode-wsl-runtime-preparation', () => ({
  prepareOpenCodeWslReaders: async () => []
}))

const a: Repo = {
  id: 'a',
  path: '/clones/a/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1,
  upstream: { owner: 'acme', repo: 'app' }
}
const b: Repo = { ...a, id: 'b', path: '/clones/b/app', addedAt: 2 }
let root: string | undefined
let harness: SessionSearchHarness | undefined

afterEach(async () => {
  resetAiVaultSessionListCacheForTests()
  scanTranscripts.mockReset()
  vi.restoreAllMocks()
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
  await harness?.close()
  await closeTestStores()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  harness = undefined
  root = undefined
})

async function seededStore(
  name: string,
  repos: Repo[] = [a, b],
  provisioned: readonly string[] = []
) {
  root ??= await realpath(await mkdtemp(join(tmpdir(), 'sta10541-source-')))
  const path = join(root, name, 'state.json')
  const state = getDefaultPersistedState(root)
  state.repos = repos
  const raw = projectHostSetupCompatibilityFromRepos(state.repos)
  state.projects = [...raw.projects]
  state.projectHostSetups = raw.setups.map((setup) =>
    provisioned.includes(setup.repoId) ? { ...setup, setupMethod: 'provisioned' } : setup
  )
  state.settings.workspaceDir = join(root, 'workspaces')
  state.settings.nestWorkspaces = false
  writePersistedStateJson(path, JSON.stringify(state))
  return createSqliteTestStore(Store, { dataFile: path })
}

function caller(store: Store, repo: Repo, path: string) {
  const meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, `${repo.id}::${path}`)
  const readState = {
    repos: store.getRepos(),
    endpointProjects: store.getProjects(),
    endpointProjectHostSetups: store.getProjectHostSetups()
  }
  const worktree = withRepoHostOwnership(
    makeWorktree({ id: `${repo.id}::${path}`, repoId: repo.id, path, ...meta }),
    getRepoExecutionHostId(repo),
    getProjectHostSetupForRepoHost(readState, repo.id, getRepoExecutionHostId(repo))
  )
  const old = legacyProjection(
    readState.repos,
    readState.endpointProjects,
    readState.endpointProjectHostSetups
  )
  return {
    meta,
    worktree,
    legacy: resolveLegacyActiveProjectKey(repo, worktree, buildSetupByRepoId(old.setups)),
    canonical: resolveActiveProjectKey(
      repo,
      worktree,
      getProjectHostSetupLookup(getProjectHostSetupProjectionFromState(readState).setups)
    )
  }
}

// The integrated-base within schema: unknown Project properties are stripped.
const baseWithin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), worktreeId: z.string().min(1).max(8192) }),
  z.object({ kind: z.literal('project'), projectKey: z.string().min(1).max(1024) })
])
const baseRequest = AiVaultSearchRequestSchema.safeExtend({ within: baseWithin.optional() })

it('pairs old discovery with canonical persistence, compatibility backfill, selected callers and actual legacy/native results', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const oldStore = await seededStore('old-source')
  const newStore = await seededStore('new-source')
  const raw = projectHostSetupCompatibilityFromRepos([a, b])
  const projectKey = `project:${raw.projects[0].id}`
  const oldSetups = vi.spyOn(oldStore, 'getProjectHostSetups').mockReturnValue([...raw.setups])
  harness = await openSessionSearchHarness('sta10541-source-results')
  addSyntheticSession(harness.db, { id: 1, cwd: a.path })
  addSyntheticSession(harness.db, { id: 2, cwd: '/external/b' })
  setSessionSearchService(
    createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
  )
  const lastActivityAt = Date.now()
  for (const foreign of [false, true]) {
    const id = 'b::/external/b'
    oldStore.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
      projectId: foreign ? 'saved:S' : raw.projects[0].id,
      projectHostSetupId: foreign ? 'foreign-setup' : 'b',
      instanceId: 'existing-b',
      lastActivityAt
    })
    newStore.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
      projectId: foreign ? 'saved:S' : 'repo:b',
      projectHostSetupId: foreign ? 'foreign-setup' : 'b',
      instanceId: 'existing-b',
      lastActivityAt
    })
    const before = caller(oldStore, b, '/external/b')
    const after = caller(newStore, b, '/external/b')
    expect(after.legacy).toBe(before.legacy)
    expect(after.legacy).toBe(foreign ? 'project:saved:S' : projectKey)
    expect(after.meta.lastActivityAt).toBe(lastActivityAt)
    expect(after.meta.projectHostSetupId).toBe(foreign ? 'foreign-setup' : 'b')
    expect(after.canonical).toBe(foreign ? 'project:saved:S' : 'repo:b')
    installSessionSearchScopeCatalogSource(() =>
      sessionSearchScopeCatalogFromStore(newStore, 'local')
    )
    const request = {
      query: 'needle',
      within: {
        kind: 'project' as const,
        projectKey: after.legacy!,
        canonicalProjectKey: after.canonical!
      }
    }
    const stripped = baseRequest.parse(request)
    expect(stripped.within).toEqual({ kind: 'project', projectKey: before.legacy })
    const legacy = await searchSessionService(stripped, 'ipc')
    expect(legacy.kind === 'results' && legacy.hits.map((hit) => hit.sessionId).sort()).toEqual(
      foreign ? ['2'] : ['1', '2']
    )
    const exact = await searchSessionService(request, 'ipc')
    expect(exact.kind === 'results' && exact.hits.map((hit) => hit.sessionId)).toEqual(['2'])
  }
  oldSetups.mockRestore()
  newStore.flushOrThrow()
  await newStore.freezeWritesAsync()
  const reloaded = createSqliteTestStore(Store, {
    dataFile: join(root!, 'new-source', 'state.json')
  })
  expect(caller(reloaded, b, '/external/b').legacy).toBe('project:saved:S')
})

it('retains browser nested execution facts, omitted exact setup reconstruction and global first-setup ordering', () => {
  const target = { kind: 'environment', environmentId: 'hub' } as const
  const nested: Repo = { ...b, id: a.id, connectionId: 'jump', executionHostId: 'runtime:hub' }
  const repos = [a, adoptEndpointRepo(target, nested)]
  const raw = projectHostSetupCompatibilityFromRepos([
    a,
    { ...nested, executionHostId: 'ssh:jump' }
  ])
  const adopted = adoptEndpointProjectCatalog(
    target,
    raw.projects,
    raw.setups.filter((setup) => setup.connectionId)
  )
  const state = {
    repos,
    endpointProjects: adopted.projects,
    endpointProjectHostSetups: adopted.setups
  }
  const canonical = getProjectHostSetupProjectionFromState(state)
  const selected = resolveActiveProjectKey(
    repos[1],
    null,
    getProjectHostSetupLookup(canonical.setups)
  )
  expect(selected).toBe(`project:${raw.projects[0].id}`)
  expect(resolveActiveProjectKey(a, null, getProjectHostSetupLookup(canonical.setups))).toBe(
    selected
  )
  const compatibility = legacyProjection(repos, adopted.projects, adopted.setups)
  const first = buildSetupByRepoId(compatibility.setups)
  expect(first.get(a.id)).toBe(compatibility.setups.find((setup) => setup.repoId === a.id))
  const foreign = makeWorktree({
    id: 'a::/foreign',
    repoId: a.id,
    path: '/foreign',
    projectId: 'saved:S',
    projectHostSetupId: 'foreign'
  })
  expect(resolveLegacyActiveProjectKey(a, foreign, first)).toBe('project:saved:S')
})

it('keeps erased never-opened external history unscoped after authoritative prune while retaining an empty-tab owner', async () => {
  const store = await seededStore('erased-source')
  store.updateSettings({ nestWorkspaces: true })
  const repo = store.getRepos().find((row) => row.id === a.id)!
  const erased = `${a.id}::${root}/workspaces/app/topic`
  const retained = `${a.id}::${root}/workspaces/app/retained`
  // Actual discovery creates locator/instance metadata; no tab is ever opened for topic.
  resolveWorktreeMetaWithDiscoveryBackfill(store, repo, erased)
  resolveWorktreeMetaWithDiscoveryBackfill(store, repo, retained)
  store.setWorkspaceSession({ ...store.getWorkspaceSession(), tabsByWorktree: { [retained]: [] } })
  const scan = store.captureNativeLocalWorktreeMetadataScanExpectation(repo)
  const pruned = await pruneMetadataMissingFromAuthoritativeLocalScan({
    store,
    repo,
    scan,
    scanGeneration: getLocalWorktreeScanGeneration(repo.id),
    gitWorktrees: [
      { path: repo.path, head: 'same-commit', branch: '', isBare: false, isMainWorktree: true }
    ],
    pathsExistOrAreUnverifiable: async (paths) => new Map(paths.map((path) => [path, false]))
  })
  expect(pruned.removedWorktreeIds).toContain(erased)
  expect(pruned.removedWorktreeIds).not.toContain(retained)
  expect(store.getWorktreeMeta(erased)).toBeUndefined()
  harness = await openSessionSearchHarness('sta10541-erased-source')
  addSyntheticSession(harness.db, { id: 1, cwd: `${root}/workspaces/app/topic` })
  addSyntheticSession(harness.db, { id: 2, cwd: `${root}/workspaces/app/retained` })
  setSessionSearchService(
    createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
  )
  installSessionSearchScopeCatalogSource(() => sessionSearchScopeCatalogFromStore(store, 'local'))
  const projectKey = `project:${projectHostSetupCompatibilityFromRepos([a, b]).projects[0].id}`
  const shared = await searchSessionService(
    { query: 'needle', within: { kind: 'project', projectKey, canonicalProjectKey: projectKey } },
    'ipc'
  )
  const independent = await searchSessionService(
    { query: 'needle', within: { kind: 'project', projectKey, canonicalProjectKey: 'repo:b' } },
    'ipc'
  )
  const all = await searchSessionService({ query: 'needle' }, 'ipc')
  expect(shared.kind === 'results' && shared.hits.map((hit) => hit.sessionId)).toEqual(['2'])
  expect(independent.kind === 'results' && independent.hits).toEqual([])
  expect(all.kind === 'results' && all.hits.map((hit) => hit.sessionId).sort()).toEqual(['1', '2'])
  const read = {
    repos: store.getRepos(),
    endpointProjects: store.getProjects(),
    endpointProjectHostSetups: store.getProjectHostSetups()
  }
  const transcriptRows = ['topic', 'retained'].map((name) =>
    aiVaultSearchHitToSession(
      { ...searchHit(), sessionId: name, cwd: `${root}/workspaces/app/${name}` },
      'local'
    )
  )
  scanTranscripts.mockResolvedValue({
    sessions: transcriptRows,
    issues: [],
    scannedAt: 'same-scan'
  })
  const capture = vi.fn(() => sessionSearchScopeCatalogFromStore(store, 'local'))
  configureAiVaultSessionSources({ getProjectOwnershipCatalog: capture })
  // Non-opted list shares the parse cache but neither captures nor annotates ownership.
  const legacy = await listAiVaultSessions({ limit: 2 })
  expect(legacy.sessions).toEqual(transcriptRows)
  expect(capture).not.toHaveBeenCalled()
  const opted = await listAiVaultSessions({ limit: 2, historyOwnership: {} })
  expect(opted.sessions.map((row) => row.projectOwnerKey)).toEqual([null, projectKey])
  expect(opted.fingerprint).toBeUndefined()
  expect(scanTranscripts).toHaveBeenCalledTimes(1)
  const render = (result: AiVaultListResult) =>
    buildAiVaultSessionProjectById({
      repos: read.repos,
      projectHostSetupProjection: getProjectHostSetupProjectionFromState(read),
      worktrees: [], // Successful Git listing has no retained actionable workspace.
      sessions: result.sessions
    })
  const decoded = parseAiVaultListResult(restampAiVaultListResult(opted, 'runtime:answering'))
  const merged = mergeAiVaultListResults([decoded], 2)
  const rows = render(merged)
  expect([...rows.values()].map((row) => row.key)).toEqual([
    expect.stringMatching(/^folder:/),
    projectKey
  ])
  const filter = (activeProjectKey: string) =>
    filterAiVaultSessions(merged.sessions, {
      query: '',
      agents: ['codex'],
      scope: 'project',
      sort: 'updated',
      activeWorktreePaths: [],
      activeProjectKey,
      sessionProjectById: rows,
      hideEmptySessions: false
    })
  expect(filter(projectKey).map((row) => row.sessionId)).toEqual(['retained'])
  expect(filter('repo:b')).toEqual([])
  expect(merged.sessions[1]).toMatchObject({
    cwd: transcriptRows[1].cwd,
    filePath: transcriptRows[1].filePath,
    executionHostId: 'runtime:answering'
  })
  store.setWorktreeMeta(hostWorktreeTarget({ id: retained, hostId: 'local' }), {
    projectHostSetupId: 'b',
    projectId: 'repo:b'
  })
  const changed = await listAiVaultSessions({ limit: 2, historyOwnership: {} })
  expect(changed.scannedAt).toBe(opted.scannedAt)
  expect(changed.fingerprint).toBeUndefined()
  expect(opted.sessions[1].projectOwnerKey).toBe(projectKey)
  expect(changed.sessions[1].projectOwnerKey).toBe('repo:b')
  expect(scanTranscripts).toHaveBeenCalledTimes(1)
  expect((await listAiVaultSessions({ limit: 2 })).sessions).toEqual(transcriptRows)
  // A malformed optional owner costs its annotation, never the transcript.
  const malformed = parseAiVaultListResult({
    ...opted,
    sessions: [{ ...transcriptRows[0], projectOwnerKey: 42 }]
  })
  expect(malformed.sessions).toHaveLength(1)
  expect(malformed.sessions[0].projectOwnerKey).toBeUndefined()
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  capture.mockImplementationOnce(() => {
    throw new Error('ownership source unavailable')
  })
  const fallback = await listAiVaultSessions({ limit: 2, historyOwnership: {} })
  expect(fallback.sessions).toEqual(transcriptRows)
  expect(report).toHaveBeenCalledOnce()

  const explicitUnknown = render({
    ...opted,
    sessions: [{ ...transcriptRows[0], cwd: a.path, projectOwnerKey: null }]
  })
  expect([...explicitUnknown.values()][0].kind).toBe('folder')
})

it('ignores real Store activity during a held native reply while preserving governing changes', async () => {
  const store = await seededStore('activity')
  const target = hostWorktreeTarget({ id: `b::${b.path}`, hostId: 'local' })
  store.setWorktreeMeta(target, { lastActivityAt: 100 })
  let entered = () => {},
    release = () => {}
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  setSessionSearchService({
    reconcile: async () => {},
    status: async () => {
      throw new Error('unused')
    },
    search: async () => {
      entered()
      await held
      return {
        kind: 'results',
        hits: [],
        page: { cursor: null, hasMore: false },
        generation: 1,
        durationMs: 0,
        truncated: { candidates: false, snippets: 0, query: false, freshness: false }
      }
    }
  })
  installSessionSearchScopeCatalogSource(() => sessionSearchScopeCatalogFromStore(store, 'local'))
  const pending = searchSessionService(
    {
      query: 'needle',
      within: { kind: 'project', projectKey: 'repo:b', canonicalProjectKey: 'repo:b' }
    },
    'ipc'
  )
  await reached
  store.setWorktreeMeta(target, { lastActivityAt: 101 })
  expect(store.getWorktreeMeta(target.id)?.lastActivityAt).toBe(101)
  release()
  expect(await pending).toMatchObject({ kind: 'results' })
})

it('preserves actual discovered selected-source legacy keys across supported catalog ingress controls', async () => {
  const cases: Repo[][] = [
    [a],
    [a, b],
    [a, b],
    [{ ...a, kind: 'folder' }],
    [{ ...a, upstream: undefined }],
    [a, { ...b, projectGroupId: 'manual-group' }],
    [a, { ...b, executionHostId: 'runtime:pending' }],
    [a, { ...b, executionHostId: 'runtime:unresolved-owner' }]
  ]
  for (const [index, repos] of cases.entries()) {
    const provisioned = index === 2 ? ['b'] : []
    const old = await seededStore(`old-ingress-${index}`, repos, provisioned)
    const current = await seededStore(`new-ingress-${index}`, repos, provisioned)
    const raw = projectHostSetupCompatibilityFromRepos(repos)
    raw.setups = raw.setups.map((setup) =>
      provisioned.includes(setup.repoId) ? { ...setup, setupMethod: 'provisioned' } : setup
    )
    const original = vi.spyOn(old, 'getProjectHostSetups').mockReturnValue([...raw.setups])
    const repo = repos.at(-1)!
    const before = caller(old, repo, repo.path)
    const after = caller(current, repo, repo.path)
    expect(after.legacy, `ingress ${index}`).toBe(before.legacy)
    expect(after.worktree.path).toBe(repo.path)
    expect(after.worktree.repoId).toBe(repo.id)
    original.mockRestore()
  }
})
