import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildValidWorktreeIdsForSessionHydration } from '../../../../shared/worktree/degraded-repo-worktree-validity'
import { recentlyRenamedWorktreeIdExpiry } from '@/lib/worktree-rename-grace'
import {
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab
} from './store-session-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { purgeHydratedWorktrees } from './worktrees/listing/hydrated-worktree-purge'
import { getRemovedWorktreeIdsAfterAuthoritativeScan } from './worktrees/listing/worktree-host-ownership'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

const OLD = 'repo1::C:\\work\\repo'
const NEW = 'repo1::C:/work/repo'
const GONE = 'repo1::C:/work/gone'
const repo = {
  id: 'repo1',
  path: 'C:/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
function browser(id: string, worktreeId: string): BrowserWorkspace {
  return {
    id,
    worktreeId,
    url: 'https://example.com',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}
const listed = makeWorktree({ id: NEW, repoId: repo.id, path: repo.path })

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  recentlyRenamedWorktreeIdExpiry.clear()
})

describe('saved worktree spelling recovery', () => {
  it('recovers split tabs into the listed spelling without replacing its layout or selection', async () => {
    const store = createTestStore()
    const paneLayout = makeLayout()
    const destinationLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'left' },
      second: { type: 'leaf' as const, groupId: 'destination' }
    }
    store.setState({
      repos: [repo],
      worktreesByRepo: { repo1: [makeWorktree({ ...listed, id: OLD })] },
      tabsByWorktree: {
        [OLD]: [
          makeTab({ id: 'recovered', worktreeId: OLD }),
          makeTab({ id: 'kept', worktreeId: OLD })
        ],
        [NEW]: [makeTab({ id: 'kept', worktreeId: NEW })]
      },
      unifiedTabsByWorktree: {
        [OLD]: [
          makeUnifiedTab({ id: 'recovered', worktreeId: OLD, groupId: 'source' }),
          makeUnifiedTab({ id: 'kept', worktreeId: OLD, groupId: 'source' })
        ],
        [NEW]: [makeUnifiedTab({ id: 'kept', worktreeId: NEW, groupId: 'destination' })]
      },
      groupsByWorktree: {
        [OLD]: [makeTabGroup({ id: 'source', worktreeId: OLD, tabOrder: ['recovered', 'kept'] })],
        [NEW]: [
          makeTabGroup({ id: 'left', worktreeId: NEW }),
          makeTabGroup({
            id: 'destination',
            worktreeId: NEW,
            activeTabId: 'kept',
            tabOrder: ['kept']
          })
        ]
      },
      layoutByWorktree: { [OLD]: { type: 'leaf', groupId: 'source' }, [NEW]: destinationLayout },
      activeGroupIdByWorktree: { [OLD]: 'source', [NEW]: 'destination' },
      activeTabIdByWorktree: { [OLD]: 'recovered', [NEW]: 'kept' },
      terminalLayoutsByTabId: { recovered: paneLayout },
      browserTabsByWorktree: {
        [OLD]: [browser('source-browser', OLD), browser('kept-browser', OLD)],
        [NEW]: [browser('kept-browser', NEW)]
      },
      activeBrowserTabIdByWorktree: { [OLD]: 'source-browser', [NEW]: 'kept-browser' },
      openFiles: [
        makeOpenFile({ id: 'source-file', worktreeId: OLD }),
        makeOpenFile({ id: 'kept-file', worktreeId: NEW })
      ]
    })
    worktreeListMock.mockResolvedValue([listed])

    await store.getState().fetchWorktrees(repo.id)

    const state = store.getState()
    expect(state.tabsByWorktree[OLD]).toBeUndefined()
    expect(state.tabsByWorktree[NEW].map((tab) => tab.id)).toEqual(['kept', 'recovered'])
    expect(
      state.unifiedTabsByWorktree[NEW].map((tab) => [tab.id, tab.groupId, tab.worktreeId])
    ).toEqual([
      ['kept', 'destination', NEW],
      ['recovered', 'destination', NEW]
    ])
    expect(state.groupsByWorktree[NEW][1]).toMatchObject({
      activeTabId: 'kept',
      tabOrder: ['kept', 'recovered']
    })
    expect(state.layoutByWorktree[NEW]).toBe(destinationLayout)
    expect(state.activeGroupIdByWorktree[NEW]).toBe('destination')
    expect(state.activeTabIdByWorktree[NEW]).toBe('kept')
    expect(state.terminalLayoutsByTabId.recovered).toBe(paneLayout)
    expect(state.browserTabsByWorktree[OLD]).toBeUndefined()
    expect(state.browserTabsByWorktree[NEW].map((tab) => [tab.id, tab.worktreeId])).toEqual([
      ['kept-browser', NEW],
      ['source-browser', NEW]
    ])
    expect(state.activeBrowserTabIdByWorktree[NEW]).toBe('kept-browser')
    expect(state.openFiles.map((file) => [file.id, file.worktreeId])).toEqual([
      ['kept-file', NEW],
      ['source-file', NEW]
    ])
    expect(recentlyRenamedWorktreeIdExpiry.get(OLD)).toBeGreaterThan(Date.now())
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
  })

  it('renames an unsplit saved layout when the listed spelling has no state', async () => {
    const store = createTestStore()
    const layout = { type: 'leaf' as const, groupId: 'original' }
    store.setState({
      repos: [repo],
      tabsByWorktree: { [OLD]: [makeTab({ id: 'saved', worktreeId: OLD })] },
      layoutByWorktree: { [OLD]: layout },
      activeTabIdByWorktree: { [OLD]: 'saved' }
    })
    worktreeListMock.mockResolvedValue([listed])
    await store.getState().fetchWorktrees(repo.id)
    expect(store.getState().layoutByWorktree).toEqual({ [NEW]: layout })
    expect(store.getState().activeTabIdByWorktree).toEqual({ [NEW]: 'saved' })
  })

  it('keeps spelling variants through authoritative and hydration purges while purging real removals', () => {
    const store = createTestStore()
    const detected = makeDetectedResult(repo.id, [listed])
    store.setState({
      repos: [repo],
      hydrationSucceeded: true,
      workspaceSessionReady: true,
      tabsByWorktree: { [OLD]: [makeTab({ id: 'saved', worktreeId: OLD })], [GONE]: [] },
      worktreesByRepo: {
        repo1: [makeWorktree({ ...listed, id: OLD }), makeWorktree({ ...listed, id: GONE })]
      },
      detectedWorktreesByRepo: { repo1: detected },
      purgeWorktreeTerminalState: vi.fn()
    })
    expect(
      getRemovedWorktreeIdsAfterAuthoritativeScan(store.getState(), repo.id, detected, 'local')
    ).toEqual([GONE])
    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [repo],
        worktreesByRepo: { repo1: [listed] },
        detectedWorktreesByRepo: { repo1: detected }
      },
      [OLD, GONE]
    )
    expect(valid.has(OLD)).toBe(true)
    expect(valid.has(GONE)).toBe(false)
    purgeHydratedWorktrees(store.setState, store.getState, [
      {
        repoId: repo.id,
        hostId: 'local',
        refresh: { status: 'admitted', executionHostId: 'local', result: detected }
      }
    ])
    expect(store.getState().purgeWorktreeTerminalState).toHaveBeenCalledWith([GONE])
  })

  it('leaves the other host’s saved spelling and same-id twin untouched', async () => {
    const store = createTestStore()
    const remoteTab = makeTab({ id: 'remote', worktreeId: OLD })
    store.setState({
      repos: [repo, { ...repo, executionHostId: 'runtime:other' }],
      worktreesByRepo: {
        repo1: [listed, makeWorktree({ ...listed, id: OLD, hostId: 'runtime:other' })]
      },
      tabsByWorktree: { [OLD]: [remoteTab] },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [OLD]: 'runtime:other' }
    })
    worktreeListMock.mockResolvedValue([listed])
    await store.getState().fetchWorktrees(repo.id, { forceLocalOwner: true })
    expect(store.getState().tabsByWorktree[OLD]).toEqual([remoteTab])
    expect(store.getState().tabsByWorktree[NEW]).toBeUndefined()
    expect(store.getState().worktreesByRepo.repo1).toContainEqual(
      expect.objectContaining({ id: OLD, hostId: 'runtime:other' })
    )
  })
})
