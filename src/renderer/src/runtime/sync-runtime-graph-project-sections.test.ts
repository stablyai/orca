import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import { getDefaultSettings } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'

vi.mock('./sync-runtime-graph/terminal-group-grid-sizes', () => ({
  measureTerminalGroupGridSizes: () => undefined
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/Users/me/orca',
  displayName: 'orca',
  badgeColor: '#737373',
  addedAt: 1,
  hookSettings: { mode: 'auto', scripts: { setup: 'secret-setup', archive: '' } },
  gitUsername: 'me',
  repoIcon: { type: 'image', src: 'data:image/png;base64,AAAA', source: 'upload' }
}

const BASE_STATE = {
  settings: getDefaultSettings(''),
  projectGroupingSettingsHydrated: true,
  localRepoCatalogHydrated: true,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  runtimePaneTitlesByTabId: {},
  groupsByWorktree: {},
  activeGroupIdByWorktree: {},
  layoutByWorktree: {},
  unifiedTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  activeFileId: null,
  activeFileIdByWorktree: {},
  openFiles: [],
  editorDrafts: {},
  activeTabId: null,
  agentStatusByPaneKey: {},
  browserTabsByWorktree: {},
  repos: [repo],
  projects: [],
  projectHostSetups: [],
  projectOrderBy: 'recent'
}

async function flushSync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the sidebar's Project catalog in the window graph", () => {
  it.each([100, 1000])(
    'does no catalog work on unrelated settings writes with %i registrations',
    async (count) => {
      const syncWindowGraph = vi
        .fn<(graph: RuntimeSyncWindowGraph) => Promise<object>>()
        .mockResolvedValue({})
      vi.useFakeTimers()
      vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
      vi.stubGlobal('HTMLElement', class HTMLElement {})
      let reads = 0
      const repos = Array.from({ length: count }, (_, i) => ({
        ...repo,
        get id() {
          reads++
          return `repo-${i}`
        },
        path: `/repos/${i}`
      }))
      let state = { ...BASE_STATE, repos, settings: getDefaultSettings('') }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the graph fixture supplies every field this path reads.
      setRuntimeGraphStoreStateGetter(() => state as unknown as AppState)
      setRuntimeGraphSyncEnabled(true)
      await flushSync()
      expect(syncWindowGraph.mock.calls[0]?.[0].projectSectionCatalog?.setups).toHaveLength(count)
      expect(reads).toBeLessThan(100 * count)
      reads = 0
      state = {
        ...state,
        settings: {
          ...state.settings,
          terminalFontSize: 19,
          projectGroupingOverrides: { ...state.settings.projectGroupingOverrides }
        }
      }
      scheduleRuntimeGraphSync()
      await flushSync()
      expect(reads).toBe(0)
      expect(syncWindowGraph.mock.lastCall?.[0]).not.toHaveProperty('projectSectionCatalog')
      state = { ...state, settings: { ...state.settings, projectGroupingMode: 'folder' } }
      scheduleRuntimeGraphSync()
      await flushSync()
      expect(syncWindowGraph.mock.lastCall?.[0]).toHaveProperty('projectSectionCatalog')
    }
  )

  it('carries it once per change, without repo hooks, credentials or uploaded icons', async () => {
    const syncWindowGraph = vi
      .fn<(graph: RuntimeSyncWindowGraph) => Promise<object>>()
      .mockResolvedValue({})
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    let state = BASE_STATE
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph sync reads only these members of the store.
    setRuntimeGraphStoreStateGetter(() => state as unknown as AppState)
    setRuntimeGraphSyncEnabled(true)
    await flushSync()

    expect(syncWindowGraph.mock.calls[0]?.[0].projectSectionCatalog).toEqual({
      repos: [
        {
          id: 'repo-1',
          displayName: 'orca',
          path: '/Users/me/orca',
          badgeColor: '#737373',
          addedAt: 1
        }
      ],
      projects: [{ id: 'repo:repo-1', displayName: 'orca' }],
      setups: [
        {
          id: 'repo-1',
          groupKey: 'project:repo:repo-1',
          projectId: 'repo:repo-1',
          hostId: 'local',
          repoId: 'repo-1',
          path: '/Users/me/orca',
          displayName: 'orca',
          setupMethod: 'legacy-repo'
        }
      ],
      projectOrderBy: 'recent'
    })

    scheduleRuntimeGraphSync()
    await flushSync()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
    expect(syncWindowGraph.mock.calls[1]?.[0]).not.toHaveProperty('projectSectionCatalog')

    state = { ...BASE_STATE, projectOrderBy: 'manual' }
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(syncWindowGraph.mock.calls[2]?.[0].projectSectionCatalog?.projectOrderBy).toBe('manual')
  })
})
