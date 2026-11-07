import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { mergeProjectCompatibilityForHostRepoChange } from './repo-catalog-identity'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '..'
import { getDefaultSettings } from '../../../../shared/constants'
import { retireRemovedProjectGroupingState } from './project-grouping-preferences'
import type { SettingsUpdate } from '../slices/settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createTestStore } from '../slices/store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'

const repo: Repo = {
  id: 'a',
  path: '/a',
  displayName: 'App',
  badgeColor: '',
  addedAt: 0,
  upstream: { owner: 'org', repo: 'app' }
}
afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it.each([100, 1000])(
  'retires %i historical collapse keys in one current-state mutation',
  async (count) => {
    const persist = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: persist } } })
    const unrelated = Array.from({ length: count }, (_, i) => `project-group:other-${i}`)
    const settings = {
      ...getDefaultSettings(''),
      projectGroupingOverrides: { 'github:org/app': 'folder' as const, offline: 'host' as const }
    }
    const updateSettingsOrThrow = vi.fn(async (transform: SettingsUpdate) => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          ...(typeof transform === 'function'
            ? transform(useAppStore.getState().settings!)
            : transform)
        }
      })
    })
    useAppStore.setState({
      repos: [],
      settings,
      collapsedGroups: new Set([
        ...Array.from(
          { length: count },
          (_, i) => `project:github:org/app::host:local::setup:${i}`
        ),
        ...unrelated
      ]),
      updateSettingsOrThrow
    })
    // A later unrelated collapse is read by the mutation, not overwritten by a pre-removal snapshot.
    useAppStore.getState().toggleCollapsedGroup('project:repo:plain')
    persist.mockClear()
    let visited = 0
    class MeasuredSet extends Set<string> {
      override *[Symbol.iterator](): SetIterator<string> {
        for (const key of super[Symbol.iterator]()) {
          visited++
          yield key
        }
      }
    }
    useAppStore.setState({
      collapsedGroups: new MeasuredSet(useAppStore.getState().collapsedGroups)
    })
    let publications = 0
    const stop = useAppStore.subscribe((state, previous) => {
      if (state.collapsedGroups !== previous.collapsedGroups) {
        publications++
      }
    })
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    await Promise.resolve()
    expect(visited).toBe(2 * count + 1)
    expect(publications).toBe(1)
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      collapsedGroups: [...unrelated, 'project:repo:plain']
    })
    expect(useAppStore.getState().settings?.projectGroupingOverrides).toEqual({ offline: 'host' })
    persist.mockClear()
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    expect(persist).not.toHaveBeenCalled()
    expect(publications).toBe(1)
    useAppStore.setState({ repos: [{ ...repo, id: 'sibling' }] })
    updateSettingsOrThrow.mockClear()
    retireRemovedProjectGroupingState(useAppStore.getState, repo)
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    stop()
  }
)

it('retains independent catalog ownership and rechecks queued retirement against a re-added sibling', async () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  const sibling = {
    ...repo,
    id: 'remote',
    path: '/remote/a',
    executionHostId: 'runtime:server' as const
  }
  const projection = projectHostSetupProjectionFromRepos([repo, sibling])
  const merged = mergeProjectCompatibilityForHostRepoChange({
    previous: { projects: projection.projects, projectHostSetups: projection.setups },
    nextRepos: [],
    hostId: 'local'
  })
  let transform: SettingsUpdate | undefined
  const updateSettingsOrThrow = vi.fn(async (next: SettingsUpdate) => {
    transform = next
  })
  const settings = {
    ...getDefaultSettings(''),
    projectGroupingOverrides: { 'github:org/app': 'folder' as const }
  }
  useAppStore.setState({
    repos: [],
    ...merged,
    settings,
    updateSettingsOrThrow,
    collapsedGroups: new Set(['project:github:org/app'])
  })
  retireRemovedProjectGroupingState(useAppStore.getState, repo)
  expect(updateSettingsOrThrow).not.toHaveBeenCalled()
  expect(useAppStore.getState().collapsedGroups.has('project:github:org/app')).toBe(true)
  useAppStore.setState({ projects: [], projectHostSetups: [] })
  retireRemovedProjectGroupingState(useAppStore.getState, repo)
  expect(updateSettingsOrThrow).toHaveBeenCalledTimes(1)
  useAppStore.setState({ repos: [sibling] })
  expect(typeof transform === 'function' ? transform(settings) : transform).toEqual({})
})

it.each([100, 1000])(
  'uses real merged removal and queued current-owner settings retirement with %i collapse keys',
  async (count) => {
    const store = createTestStore()
    let saved: GlobalSettings = {
      ...getDefaultSettings(''),
      projectGroupingOverrides: { 'github:org/app': 'folder', offline: 'host' }
    }
    let release!: () => void
    let hold = false
    const settingsSet = vi.fn(async (updates: Partial<GlobalSettings>) => {
      if (hold) {
        hold = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      saved = { ...saved, ...updates }
      return saved
    })
    const persist = vi.fn(async (_patch: Record<string, unknown>) => {})
    const remove = vi.fn(async () => {})
    vi.stubGlobal('window', {
      api: {
        repos: { removeForHost: remove },
        settings: { get: async () => saved, set: settingsSet },
        ui: { set: persist }
      }
    })
    const local = { ...repo, executionHostId: 'local' as const }
    const remote = {
      ...repo,
      id: 'remote',
      path: '/server/a',
      executionHostId: 'runtime:server' as const
    }
    const projection = projectHostSetupProjectionFromRepos([local, remote])
    const historical = Array.from(
      { length: count },
      (_, i) => `project:github:org/app::host:local::setup:${i}`
    )
    const unrelated = Array.from({ length: count }, (_, i) => `project:repo:unrelated-${i}`)
    store.setState({
      repos: [local],
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: saved,
      collapsedGroups: new Set([...historical, ...unrelated])
    })
    await store.getState().removeProject(local.id, { hostId: 'local' })
    expect(remove).toHaveBeenCalledExactlyOnceWith({ repoId: local.id, hostId: 'local' })
    expect(store.getState().projectHostSetups).toEqual([
      projection.setups.find((setup) => setup.hostId === 'runtime:server')
    ])
    expect(store.getState().collapsedGroups.size).toBe(2 * count)
    expect(settingsSet).not.toHaveBeenCalled()
    // Hold the existing serialized writer, queue last-owner removal, then re-add a sibling before its transform executes.
    store.setState({ repos: [remote] })
    hold = true
    const first = store.getState().updateSettingsOrThrow({ compactWorktreeCards: true })
    await store.getState().removeProject(remote.id, { hostId: 'runtime:server' })
    const late = { ...local, id: 'late' }
    store.setState({
      repos: [late],
      ...(() => {
        const p = projectHostSetupProjectionFromRepos([late])
        return { projects: p.projects, projectHostSetups: p.setups }
      })()
    })
    release()
    await first
    await store.getState().updateSettingsOrThrow({})
    expect(saved.projectGroupingOverrides).toEqual({ 'github:org/app': 'folder', offline: 'host' })
    // Recreate collapse choices after the late registration; the real final removal is the measured trigger.
    let visits = 0
    class MeasuredSet extends Set<string> {
      override *[Symbol.iterator](): SetIterator<string> {
        for (const key of super[Symbol.iterator]()) {
          visits++
          yield key
        }
      }
    }
    store.setState({
      collapsedGroups: new MeasuredSet([...historical, ...unrelated, 'project:repo:plain'])
    })
    let publications = 0
    const stop = store.subscribe((state, previous) => {
      if (state.collapsedGroups !== previous.collapsedGroups) {
        publications++
      }
    })
    persist.mockClear()
    await store.getState().removeProject(late.id, { hostId: 'local' })
    await store.getState().updateSettingsOrThrow({})
    expect(visits).toBeLessThan(8 * count + 8)
    expect(visits).toBeGreaterThanOrEqual(2 * count + 1)
    expect(publications).toBe(1)
    expect(store.getState().collapsedGroups).toEqual(new Set([...unrelated, 'project:repo:plain']))
    expect(saved.projectGroupingOverrides).toEqual({ offline: 'host' })
    expect(
      persist.mock.calls.filter(([patch]) => patch && Object.hasOwn(patch, 'collapsedGroups'))
    ).toHaveLength(1)
    await store.getState().removeProject(late.id, { hostId: 'local' })
    expect(publications).toBe(1)
    settingsSet.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(
      store.getState().updateSettingsOrThrow({ projectGroupingMode: 'host' })
    ).rejects.toThrow('disk unavailable')
    await store.getState().updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: {
        ...current.projectGroupingOverrides,
        afterFailure: 'repository'
      }
    }))
    await store.getState().fetchSettings()
    expect(store.getState().settings?.projectGroupingOverrides).toEqual({
      offline: 'host',
      afterFailure: 'repository'
    })
    stop()
  }
)
