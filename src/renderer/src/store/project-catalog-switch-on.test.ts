import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { MainProjectCatalog } from '@/lib/main-project-catalog'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

// Main's catalog as the window last installed it; a test installs the next one.
type FakeCatalog = Record<'repos' | 'projectGroups' | 'projects' | 'projectHostSetups', unknown[]>
const main = vi.hoisted(() => {
  const state: { catalog: FakeCatalog; arrived: boolean; listeners: Set<() => void> } = {
    catalog: { repos: [], projectGroups: [], projects: [], projectHostSetups: [] },
    arrived: false,
    listeners: new Set()
  }
  return state
})
vi.mock('@/lib/main-project-catalog', () => ({
  readMainProjectCatalog: () => main.catalog,
  hasMainProjectCatalog: () => main.arrived,
  onMainProjectCatalogChanged: (listener: () => void) => {
    main.listeners.add(listener)
    return () => main.listeners.delete(listener)
  },
  awaitMainProjectCatalog: async () => main.arrived,
  awaitMainProjectCatalogShows: async (shows: (catalog: unknown) => boolean) =>
    main.arrived && shows(main.catalog)
}))

const api = vi.hoisted(() => ({
  projectGroups: { update: vi.fn() },
  repos: { list: vi.fn() },
  runtime: { call: vi.fn(async () => ({ ok: true, result: {} })) }
}))
vi.stubGlobal('window', { api })

const { createTestStore } = await import('./slices/store-test-helpers')
const { installProjectCatalogVersion } = await import('./project-catalog-version')
const { selectProjectGroups, selectRepos } = await import('./project-catalog-selectors')

function install(catalog: Partial<MainProjectCatalog>): void {
  main.catalog = { repos: [], projectGroups: [], projects: [], projectHostSetups: [], ...catalog }
  main.arrived = true
  main.listeners.forEach((listener) => listener())
}

const repo = (id: string): Repo => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: 'blue',
  addedAt: 1
})
const group = (id: string, name: string, updatedAt: number): ProjectGroup => ({
  id,
  name,
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt,
  executionHostId: 'local'
})

function makeStore() {
  const store = createTestStore()
  installProjectCatalogVersion(store)
  return store
}

beforeEach(() => {
  main.catalog = { repos: [], projectGroups: [], projects: [], projectHostSetups: [] }
  main.arrived = false
  main.listeners.clear()
  vi.clearAllMocks()
})

describe('project catalog selectors with the switch on', () => {
  it("read main's catalog, and a subscriber's previous state reads the catalog it was written beside", () => {
    const store = makeStore()
    install({ repos: [repo('a')] })
    const seen: string[][] = []
    store.subscribe((state, previous) =>
      seen.push([...selectRepos(previous), ...selectRepos(state)].map((row) => row.id))
    )
    install({ repos: [repo('a'), repo('b')] })

    expect(selectRepos(store.getState()).map((row) => row.id)).toEqual(['a', 'b'])
    expect(seen).toEqual([['a', 'a', 'b']])
    // The window holds no copy.
    expect(store.getState().repos).toEqual([])
  })
})

describe('catalog writes with the switch on', () => {
  it("a group rename writes no store field and succeeds once main's catalog shows it", async () => {
    const store = makeStore()
    install({ projectGroups: [group('g', 'Old', 1)] })
    api.projectGroups.update.mockImplementation(async () => {
      install({ projectGroups: [group('g', 'New', 2)] })
      return group('g', 'New', 2)
    })

    await expect(store.getState().updateProjectGroup('g', { name: 'New' })).resolves.toBe(true)
    expect(selectProjectGroups(store.getState())[0]?.name).toBe('New')
    expect(store.getState().projectGroups).toEqual([])
  })

  it("a rename main's catalog never shows fails and tells the user", async () => {
    const store = makeStore()
    install({ projectGroups: [group('g', 'Old', 1)] })
    api.projectGroups.update.mockResolvedValue(group('g', 'New', 2))

    await expect(store.getState().updateProjectGroup('g', { name: 'New' })).resolves.toBe(false)
    expect(toastError).toHaveBeenCalled()
  })
})

describe('startup with the switch on', () => {
  it("refuses to settle the catalog when main's never arrives, so the session is not hydrated against none", async () => {
    const store = makeStore()
    await expect(store.getState().awaitLocalRepoCatalogSettlement()).rejects.toThrow(
      "main's project catalog never arrived"
    )
  })

  it("a repo fetch reads nothing itself and clears only the selection main's catalog dropped", async () => {
    const store = makeStore()
    install({ repos: [repo('a'), repo('b')] })
    await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    store.setState({ activeRepoId: 'b', filterRepoIds: ['a', 'b', 'offline'] })
    install({ repos: [repo('a')] })

    await store.getState().fetchRepos({ runtimeEnvironmentId: null })

    expect(api.repos.list).not.toHaveBeenCalled()
    expect(store.getState().activeRepoId).toBeNull()
    // A repo main's catalog never held (a server not reached yet) keeps its filter.
    expect(store.getState().filterRepoIds).toEqual(['a', 'offline'])
  })
})
