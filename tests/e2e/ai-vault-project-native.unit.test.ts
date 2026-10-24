// @vitest-environment happy-dom
import { mkdtemp, realpath, mkdir, symlink, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../src/shared/repo-types'
import type { SqliteBindings, SqliteStatement } from '../../src/main/sqlite/sqlite-statement'
import SyncDatabase from '../../src/main/sqlite/sync-database'
import { NodeSqliteStatement } from '../../src/main/sqlite/node-sqlite-statement'
import * as ownership from '../../src/main/ai-vault-search/session-search-project-ownership'
import * as claims from '../../src/shared/project-checkout-claim'
import * as projection from '../../src/shared/project-catalog-canonical-projection'
import { projectHostSetupCompatibilityFromRepos } from '../../src/shared/project-host-setup-projection'
import { sessionSearchScopeCatalogFromStore } from '../../src/main/ai-vault-search/session-search-store-scope-catalog'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from '../../src/main/ai-vault-search/session-search-scope-catalog'
import { createSessionSearchService } from '../../src/main/ai-vault-search/session-search-service'
import { setSessionSearchService } from '../../src/main/ai-vault-search/session-search-service-registry'
import {
  openSessionSearchHarness,
  addSyntheticSession,
  markFork,
  type SessionSearchHarness
} from '../../src/main/ai-vault-search/session-search-engine-test-fixture'
import { registerAiVaultSearchHandlers } from '../../src/main/ipc/ai-vault-search'
import { aiVaultApi } from '../../src/preload/api/ai-vault-bridge'
import { useAiVaultPanelSearch } from '../../src/renderer/src/components/right-sidebar/use-ai-vault-search'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) }
}))
vi.mock('../../src/main/ipc/ai-vault', () => ({
  getActiveRuntimeAiVaultHostInfosResult: () => ({ hostInfos: [] })
}))
vi.mock('../../src/main/ai-vault/session-scanner-service-spawn', () => ({
  clearSessionSearchInService: async () => undefined
}))

let harness: SessionSearchHarness | undefined
let root: string | undefined
const agents = ['claude'] as const

afterEach(async () => {
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
  vi.restoreAllMocks()
  await harness?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  harness = undefined
  root = undefined
})

it('bounds actual panel-to-IPC canonical preparation and native cwd seeks at N and 10N', async () => {
  const observations: {
    size: number
    catalog: number
    admissions: number
    compilations: number
    projections: number
    claims: number
    claimFacts: number
    aliases: number
    namespace: number
    preparations: number
    executions: number
    intervalBytes: number
  }[] = []
  for (const size of [8, 80]) {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sta10541-native-trigger-')))
    const repos: Repo[] = []
    for (let index = 0; index < size; index++) {
      const actual = join(root, `real-${index}`)
      const path = join(root, `linked-${index}`)
      await mkdir(actual)
      await symlink(actual, path, 'junction')
      repos.push({
        id: `repo-${index}`,
        path,
        displayName: 'app',
        badgeColor: '',
        addedAt: index,
        upstream: { owner: 'acme', repo: 'app' }
      })
    }
    repos.push({ ...repos[0], id: 'independent', path: join(root, 'independent'), addedAt: 1000 })
    const raw = projectHostSetupCompatibilityFromRepos(repos)
    raw.setups = raw.setups.map((setup, index) =>
      index > 0 && index < size ? { ...setup, setupMethod: 'provisioned' } : setup
    )
    const source = {
      getRepos: () => repos,
      getProjects: () => raw.projects,
      getProjectHostSetups: () => raw.setups,
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({ workspaceDir: '', nestWorkspaces: false })
    }
    harness = await openSessionSearchHarness('sta10541-trigger-scaling', {
      sessionCandidateLimit: 1000
    })
    for (let id = 1; id <= size * 3; id++) {
      addSyntheticSession(harness.db, {
        id,
        cwd: join(root, `real-${(id - 1) % size}`),
        text: 'ownership needle',
        updatedAt: '2026-10-20'
      })
    }
    for (let id = size * 3 + 1; id <= size * 3 + 100; id++) {
      addSyntheticSession(harness.db, {
        id,
        cwd: repos.at(-1)!.path,
        text: 'ownership needle',
        updatedAt: '2026-10-21'
      })
    }
    markFork(harness.db, [1, 2, size * 3 + 1], 'same-opening')
    const native = createSessionSearchService({
      engine: harness.engine,
      indexer: {
        status: () => {
          throw new Error('not called')
        },
        reconcile: async () => undefined
      }
    })
    const admissions = vi.spyOn(native, 'search')
    setSessionSearchService(native)
    const catalogRead = vi.fn(() => sessionSearchScopeCatalogFromStore(source, 'local'))
    installSessionSearchScopeCatalogSource(catalogRead)
    const compile = vi.spyOn(ownership, 'compileSessionSearchProjectOwnership')
    const namespace = vi.spyOn(ownership, 'sessionSearchProjectOwns')
    const claim = vi.spyOn(claims, 'getOutclaimedProjectSetups')
    const project = vi.spyOn(projection, 'resolveProjectHostSetupProjection')
    const aliases = vi.mocked(fs.realpath)
    aliases.mockClear()
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const sqlByStatement = new WeakMap<SqliteStatement, string>()
    const prepared = SyncDatabase.prototype.prepare
    vi.spyOn(SyncDatabase.prototype, 'prepare').mockImplementation(function (
      this: SyncDatabase,
      sql
    ) {
      const statement = prepared.call(this, sql)
      sqlByStatement.set(statement, sql)
      return statement
    })
    const statements: { sql: string; bindings: SqliteBindings }[] = []
    const all = NodeSqliteStatement.prototype.all
    vi.spyOn(NodeSqliteStatement.prototype, 'all').mockImplementation(function (
      this: NodeSqliteStatement,
      ...bindings
    ) {
      const sql = sqlByStatement.get(this)
      if (sql?.includes('canonical_project_owns')) {
        statements.push({ sql, bindings })
      }
      return all.apply(this, bindings)
    })
    registerAiVaultSearchHandlers()
    Object.defineProperty(window, 'api', { configurable: true, value: { aiVault: aiVaultApi } })
    const projectKey = `project:${raw.projects[0].id}`
    const within = { kind: 'project', projectKey } as const
    const hook = renderHook(
      ({ query }) => useAiVaultPanelSearch(query, agents, within, 'all', 'relevance', projectKey),
      { initialProps: { query: 'ownership needle' } }
    )
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(20))
    act(() => hook.result.current.loadMore())
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(Math.min(40, size * 3 - 1)))
    expect(hook.result.current.hits.every((hit) => Number(hit.sessionId) <= size * 3)).toBe(true)
    hook.rerender({ query: 'path:real-' })
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(20))
    expect(hook.result.current.hits.every((hit) => Number(hit.sessionId) <= size * 3)).toBe(true)
    hook.unmount()
    const selections = await Promise.all(compile.mock.results.map((result) => result.value))
    observations.push({
      size,
      catalog: catalogRead.mock.calls.length,
      admissions: admissions.mock.calls.length,
      compilations: compile.mock.calls.length,
      projections: project.mock.calls.length,
      claims: claim.mock.calls.length,
      claimFacts: claim.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0),
      aliases: aliases.mock.calls.length,
      namespace: namespace.mock.calls.length,
      preparations: prepare.mock.calls.length,
      executions: statements.length,
      intervalBytes: selections.reduce((sum, value) => sum + JSON.stringify(value.ranges).length, 0)
    })
    expect(statements.some(({ sql }) => sql.includes('WITH matched AS MATERIALIZED'))).toBe(true)
    expect(
      statements.some(({ sql }) => sql.includes('ORDER BY updated_at DESC, id DESC LIMIT'))
    ).toBe(true)
    expect(statements.some(({ sql }) => sql.includes('WHERE id IN ('))).toBe(true)
    vi.restoreAllMocks()
    for (const { sql, bindings } of statements) {
      const plan = harness.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings)
      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /SEARCH scoped USING (?:COVERING )?INDEX sessions_cwd_key/
      )
    }
    await harness.close()
    harness = undefined
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
  const [small, large] = observations
  expect(large.admissions).toBe(small.admissions)
  expect(large.compilations).toBe(small.compilations)
  expect(large.catalog).toBe(small.catalog)
  expect(large.claims).toBe(small.claims)
  expect(large.aliases).toBeLessThanOrEqual(small.aliases * 10)
  expect(large.claimFacts).toBeLessThanOrEqual(small.claimFacts * 10)
  expect(large.intervalBytes).toBeLessThanOrEqual(small.intervalBytes * 11)
  expect(large.namespace).toBeLessThanOrEqual(small.namespace * 12)
  expect(large.preparations).toBeLessThanOrEqual(small.preparations + 2)
  expect(large.executions).toBeLessThanOrEqual(small.executions + 2)
  console.info('native-trigger-operation-counts', JSON.stringify(observations))
})

it('does not revisit one SQL cwd range per WSL namespace at N and 10N', async () => {
  const counts: number[] = []
  for (const size of [2, 20]) {
    const repos: Repo[] = Array.from({ length: size }, (_, index) => ({
      id: `wsl-${index}`,
      path: `//wsl$/D${index}/home/ada/app`,
      displayName: 'app',
      badgeColor: '',
      addedAt: index,
      upstream: { owner: 'acme', repo: 'app' }
    }))
    const raw = projectHostSetupCompatibilityFromRepos(repos)
    raw.setups = raw.setups.map((setup, index) =>
      index ? { ...setup, setupMethod: 'provisioned' } : setup
    )
    harness = await openSessionSearchHarness('sta10541-namespace-union')
    for (let id = 1; id <= 20; id++) {
      addSyntheticSession(harness.db, {
        id,
        cwd: '/home/ada/app/topic',
        sessionFilePath: `//wsl$/D${id <= 10 ? 0 : 'outside'}/home/ada/.claude/session${id}`
      })
    }
    const projectKey = `project:${raw.projects[0].id}`
    const selection = await ownership.compileSessionSearchProjectOwnership(
      {
        repos,
        projects: raw.projects,
        projectHostSetups: raw.setups,
        worktreeMeta: {},
        settings: { workspaceDir: '', nestWorkspaces: false }
      },
      projectKey
    )
    const predicate = vi.spyOn(ownership, 'sessionSearchProjectOwns')
    const sqlByStatement = new WeakMap<SqliteStatement, string>()
    const prepare = SyncDatabase.prototype.prepare
    vi.spyOn(SyncDatabase.prototype, 'prepare').mockImplementation(function (
      this: SyncDatabase,
      sql
    ) {
      const statement = prepare.call(this, sql)
      sqlByStatement.set(statement, sql)
      return statement
    })
    const statements: { sql: string; bindings: SqliteBindings }[] = []
    const all = NodeSqliteStatement.prototype.all
    vi.spyOn(NodeSqliteStatement.prototype, 'all').mockImplementation(function (
      this: NodeSqliteStatement,
      ...bindings
    ) {
      const sql = sqlByStatement.get(this)
      if (sql?.includes('canonical_project_owns')) {
        statements.push({ sql, bindings })
      }
      return all.apply(this, bindings)
    })
    for (const query of ['needle', 'path:app']) {
      const result = harness.engine.search({ query, limit: 20, filters: { ownership: selection } })
      expect(result.hits.map((hit) => Number(hit.sessionId)).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 10 }, (_, i) => i + 1)
      )
      expect(result.page.hasMore).toBe(false)
    }
    counts.push(predicate.mock.calls.length)
    vi.restoreAllMocks()
    expect(statements.length).toBeGreaterThan(0)
    for (const { sql, bindings } of statements) {
      expect(
        harness.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...bindings)
          .map((row) => row.detail)
          .join('\n')
      ).toMatch(/SEARCH scoped USING (?:COVERING )?INDEX sessions_cwd_key/)
    }
    await harness.close()
    harness = undefined
  }
  expect(counts[0]).toBeGreaterThan(0)
  expect(counts[1]).toBe(counts[0])
  console.info('namespace-union-scalar-visits', JSON.stringify(counts))
})
