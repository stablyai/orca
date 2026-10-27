import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

type DrawnStore = { getState: () => AppState }
const drawn = vi.hoisted((): { store: DrawnStore | null; main: TabsDrawnFromMain | null } => ({
  store: null,
  main: null
}))

async function drawFromMain(): Promise<{
  store: DrawnStore
  sent: () => readonly { type: string }[]
}> {
  createStoreCascadesMockApi()
  const store = createTestStore()
  const unifiedTabsByWorktree = Object.fromEntries(
    Object.entries(mockStoreState.unifiedTabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab): Tab => ({
        entityId: tab.id,
        label: 'Mobile Emulator',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        worktreeId,
        ...tab,
        contentType: 'simulator'
      }))
    ])
  )
  const groupsByWorktree = Object.fromEntries(
    Object.entries(mockStoreState.groupsByWorktree).map(([worktreeId, groups]) => [
      worktreeId,
      groups.map(({ id }): TabGroup => ({
        id,
        worktreeId,
        activeTabId: null,
        tabOrder: (unifiedTabsByWorktree[worktreeId] ?? [])
          .filter((tab) => tab.groupId === id)
          .map((tab) => tab.id)
      }))
    ])
  )
  store.setState({
    activeWorktreeId: mockStoreState.activeWorktreeId,
    activeWorkspaceExecutionHostId: mockStoreState.activeWorkspaceExecutionHostId,
    // One repo per row, so same-id rows on two hosts stay apart.
    worktreesByRepo: Object.fromEntries(
      mockStoreState
        .allWorktrees()
        .map((row, index) => [
          `repo-${index}`,
          [makeWorktree({ ...row, repoId: `repo-${index}`, path: `/path/${index}` })]
        ])
    ),
    folderWorkspaces: [],
    groupsByWorktree,
    layoutByWorktree: Object.fromEntries(
      Object.entries(groupsByWorktree).map(([worktreeId, [first, second]]) => [
        worktreeId,
        second
          ? {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', groupId: first!.id },
              second: { type: 'leaf', groupId: second.id }
            }
          : { type: 'leaf', groupId: first!.id }
      ])
    ),
    activeGroupIdByWorktree: { ...mockStoreState.activeGroupIdByWorktree },
    unifiedTabsByWorktree
  })
  drawn.main = await drawTabsFromMain(store)
  drawn.store = store
  return { store, sent: () => layoutApplyTestTransport.sent }
}

async function openThroughMain(open: () => string | null): Promise<{
  tabId: string | null
  tab: Tab | undefined
  sent: { type: string; groupId?: string; split?: unknown }[]
  store: DrawnStore
}> {
  const { store, sent } = await drawFromMain()
  const tabId = open()
  await drawn.main!.settle()
  return {
    tabId,
    tab: store.getState().unifiedTabsByWorktree['wt-1']?.find((entry) => entry.id === tabId),
    sent: sent().filter((command) => command.type === 'openSimulatorTab'),
    store
  }
}

// Open locally in group-1 without selection; the active paired-server twin must not redirect ownership.
async function expectBackgroundLocalOpen(viaMain: boolean): Promise<void> {
  const { ensureSimulatorTab } = await import('./ensure-simulator-tab')
  const { tabId, tab, sent, store } = await openThroughMain(() =>
    ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })
  )
  expect(sent).toEqual(viaMain ? [expect.objectContaining({ tabId, groupId: 'group-1' })] : [])
  expect(tab).toMatchObject({
    contentType: 'simulator',
    label: 'Mobile Emulator',
    groupId: 'group-1',
    executionHostId: 'local'
  })
  expectNotSurfaced(store, tab!)
}

function expectSurfaced(store: DrawnStore, tab: Tab): void {
  const state = store.getState()
  const group = state.groupsByWorktree['wt-1']?.find((entry) => entry.id === tab.groupId)
  expect(group?.activeTabId).toBe(tab.id)
  expect(group?.recentTabIds).toContain(tab.id)
  expect(state.activeGroupIdByWorktree['wt-1']).toBe(tab.groupId)
  expect(state.activeTabType).toBe('simulator')
}

function expectNotSurfaced(store: DrawnStore, tab: Tab): void {
  const state = store.getState()
  const group = state.groupsByWorktree['wt-1']?.find((entry) => entry.id === tab.groupId)
  expect(group?.recentTabIds ?? []).not.toContain(tab.id)
  expect(tab.lastFocusedAt).toBeUndefined()
  expect(state.activeTabType).not.toBe('simulator')
}

type MockWorktreeRow = { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
type MockTabRow = {
  id: string
  groupId: string
  worktreeId?: string
  executionHostId?: ExecutionHostId
  contentType: string
  label?: string
}

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeWorkspaceExecutionHostId: ((): ExecutionHostId | null => null)(),
  activeWorktreeId: 'wt-1',
  allWorktrees: vi.fn((): MockWorktreeRow[] => []),
  activateTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  createUnifiedTab: vi.fn(),
  createUnifiedTabInSplit: vi.fn(),
  getTab: vi.fn((tabId: string) =>
    Object.values(mockStoreState.unifiedTabsByWorktree)
      .flat()
      .find((tab) => tab.id === tabId)
  ),
  dropUnifiedTab: vi.fn(),
  folderWorkspaces: [] as {
    id: string
    projectGroupId: string
    name: string
    folderPath: string
    executionHostId: string
  }[],
  focusGroup: vi.fn(),
  groupsByWorktree: {} as Record<string, { id: string }[]>,
  layoutByWorktree: {} as Record<string, unknown>,
  settings: { mobileEmulatorEnabled: true },
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  unifiedTabsByWorktree: ((): Record<string, MockTabRow[]> => ({}))()
}))

function stubCreatedSimulatorTab(groupId: string): void {
  mockStoreState.createUnifiedTab.mockImplementation(
    (worktreeId: string, contentType: string, init: { id: string }) => {
      mockStoreState.unifiedTabsByWorktree[worktreeId] = [
        ...(mockStoreState.unifiedTabsByWorktree[worktreeId] ?? []),
        { id: init.id, groupId, contentType }
      ]
    }
  )
}

function createdSimulatorTabId(): string {
  return mockStoreState.createUnifiedTab.mock.calls[0][2].id
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => drawn.store?.getState() ?? mockStoreState
  }
}))

describe('ensureSimulatorTab', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Macintosh' }
    })
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.activeWorkspaceExecutionHostId = null
    mockStoreState.activeWorktreeId = 'wt-1'
    mockStoreState.allWorktrees.mockReset().mockReturnValue([])
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }] }
    mockStoreState.layoutByWorktree = { 'wt-1': { type: 'leaf', groupId: 'group-1' } }
    mockStoreState.settings = { mobileEmulatorEnabled: true }
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [{ id: 'sim-1', groupId: 'group-1', contentType: 'simulator' }]
    }
    mockStoreState.activateTab.mockReset()
    mockStoreState.createEmptySplitGroup.mockReset()
    mockStoreState.createUnifiedTab.mockReset()
    mockStoreState.createUnifiedTabInSplit.mockReset()
    mockStoreState.dropUnifiedTab.mockReset()
    mockStoreState.folderWorkspaces = []
    mockStoreState.focusGroup.mockReset()
    mockStoreState.setActiveTab.mockReset()
    mockStoreState.setActiveTabType.mockReset()
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      vi.resetModules()
    }
  })

  afterEach(() => {
    drawn.main?.close()
    drawn.main = null
    drawn.store = null
  })

  it('activates an existing simulator tab through unified tab state', async () => {
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBe('sim-1')

    expect(mockStoreState.activateTab).toHaveBeenCalledWith('sim-1')
    expect(mockStoreState.setActiveTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('simulator', 'wt-1')
  })

  it('does not reuse a simulator owned by a same-id sibling host', async () => {
    mockStoreState.activeWorkspaceExecutionHostId = 'runtime:host-b'
    mockStoreState.allWorktrees.mockReturnValue([
      { id: 'wt-1', hostId: 'local' },
      { id: 'wt-1', hostId: 'runtime:host-b' }
    ])
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'sim-local',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          executionHostId: 'local',
          contentType: 'simulator'
        }
      ]
    }
    stubCreatedSimulatorTab('group-1')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const { tabId, tab, sent } = await openThroughMain(() => ensureSimulatorTab('wt-1'))
      expect(tabId).not.toBe('sim-local')
      expect(sent).toEqual([])
      expect(tab).toMatchObject({
        contentType: 'simulator',
        groupId: 'group-1',
        executionHostId: 'runtime:host-b'
      })
      return
    }
    expect(ensureSimulatorTab('wt-1')).toBe(createdSimulatorTabId())
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalled()
  })

  it('reuses a simulator through an SSH worktree paired-runtime owner alias', async () => {
    mockStoreState.activeWorkspaceExecutionHostId = 'runtime:paired-host'
    mockStoreState.allWorktrees.mockReturnValue([
      { id: 'wt-1', hostId: 'local' },
      {
        id: 'wt-1',
        hostId: 'ssh:private-target',
        runtimeOwnerEnvironmentId: 'paired-host'
      }
    ])
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'sim-remote',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          executionHostId: 'runtime:paired-host',
          contentType: 'simulator'
        }
      ]
    }
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBe('sim-remote')
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })

  it('keeps same-id folder workspace simulators on their owning host', async () => {
    mockStoreState.activeWorktreeId = 'folder:shared'
    mockStoreState.activeWorkspaceExecutionHostId = 'runtime:paired-host'
    mockStoreState.activeGroupIdByWorktree = { 'folder:shared': 'group-1' }
    mockStoreState.groupsByWorktree = { 'folder:shared': [{ id: 'group-1' }] }
    mockStoreState.folderWorkspaces = [
      {
        id: 'shared',
        projectGroupId: 'local-group',
        name: 'Local folder',
        folderPath: '/local/folder',
        executionHostId: 'local'
      },
      {
        id: 'shared',
        projectGroupId: 'remote-group',
        name: 'Remote folder',
        folderPath: '/remote/folder',
        executionHostId: 'runtime:paired-host'
      }
    ]
    mockStoreState.unifiedTabsByWorktree = {
      'folder:shared': [
        {
          id: 'sim-local',
          groupId: 'group-1',
          worktreeId: 'folder:shared',
          executionHostId: 'local',
          contentType: 'simulator'
        },
        {
          id: 'sim-remote',
          groupId: 'group-1',
          worktreeId: 'folder:shared',
          executionHostId: 'runtime:paired-host',
          contentType: 'simulator'
        }
      ]
    }
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('folder:shared')).toBe('sim-remote')
  })

  it('cancels pending managed shutdown when surfacing a simulator tab', async () => {
    vi.useFakeTimers()
    let cancelPendingSimulatorPaneShutdown: ((worktreeId: string) => void) | null = null
    try {
      const shutdownManagedSimulator = vi.fn()
      const scheduler = await import('./simulator-pane-shutdown-scheduler')
      cancelPendingSimulatorPaneShutdown = scheduler.cancelPendingSimulatorPaneShutdown
      scheduler.scheduleSimulatorPaneManagedShutdown('wt-1', 'sim-old', {
        delayMs: 100,
        getTabsForWorktree: () => [{ id: 'terminal-1', contentType: 'terminal' }],
        shutdownManagedSimulator
      })

      const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

      expect(ensureSimulatorTab('wt-1')).toBe('sim-1')

      await vi.advanceTimersByTimeAsync(100)
      expect(shutdownManagedSimulator).not.toHaveBeenCalled()
    } finally {
      cancelPendingSimulatorPaneShutdown?.('wt-1')
      vi.useRealTimers()
    }
  })

  it('creates a simulator tab in a new right split when requested', async () => {
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.createUnifiedTabInSplit.mockReturnValue({
      id: 'sim-2',
      groupId: 'group-2',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const { tab, sent, store } = await openThroughMain(() =>
        ensureSimulatorTab('wt-1', { placement: 'rightSplit' })
      )
      expect(sent).toEqual([
        expect.objectContaining({ split: { besideGroupId: 'group-1', direction: 'right' } })
      ])
      expect(tab).toMatchObject({ contentType: 'simulator', label: 'Mobile Emulator' })
      expect(tab!.groupId).not.toBe('group-1')
      expect(sent[0]).toMatchObject({ groupId: tab!.groupId })
      expectSurfaced(store, tab!)
      return
    }
    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit' })).toBe('sim-2')

    expect(mockStoreState.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTabInSplit).toHaveBeenCalledWith(
      'wt-1',
      'simulator',
      {
        sourceGroupId: 'group-1',
        splitDirection: 'right'
      },
      {
        label: 'Mobile Emulator',
        activate: true
      }
    )
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).not.toHaveBeenCalled()
    expect(mockStoreState.setActiveTabType).not.toHaveBeenCalled()
  })

  it('reuses an existing right split when requested', async () => {
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }, { id: 'group-2' }] }
    mockStoreState.layoutByWorktree = {
      'wt-1': {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      }
    }
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    stubCreatedSimulatorTab('group-2')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const { tab, sent, store } = await openThroughMain(() =>
        ensureSimulatorTab('wt-1', { placement: 'rightSplit' })
      )
      expect(sent).toEqual([expect.objectContaining({ groupId: 'group-2' })])
      expect(sent[0]).not.toHaveProperty('split')
      expect(tab).toMatchObject({ label: 'Mobile Emulator', groupId: 'group-2' })
      expectSurfaced(store, tab!)
      return
    }
    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit' })).toBe(createdSimulatorTabId())

    expect(mockStoreState.createUnifiedTabInSplit).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      id: expect.any(String),
      label: 'Mobile Emulator',
      targetGroupId: 'group-2',
      activate: true
    })
    expect(mockStoreState.activateTab).toHaveBeenCalledWith(createdSimulatorTabId())
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('simulator', 'wt-1')
  })

  it('falls back to the source group when atomic right split creation fails', async () => {
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.createUnifiedTabInSplit.mockReturnValue(null)
    stubCreatedSimulatorTab('group-1')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const { tabId, tab, sent, store } = await openThroughMain(() =>
        ensureSimulatorTab('wt-1', { placement: 'rightSplit' })
      )
      expect(sent).toEqual([
        expect.objectContaining({ tabId, split: { besideGroupId: 'group-1', direction: 'right' } })
      ])
      expect(tab).toMatchObject({ contentType: 'simulator', label: 'Mobile Emulator' })
      expectSurfaced(store, tab!)
      return
    }
    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit' })).toBe(createdSimulatorTabId())

    expect(mockStoreState.createUnifiedTabInSplit).toHaveBeenCalledWith(
      'wt-1',
      'simulator',
      {
        sourceGroupId: 'group-1',
        splitDirection: 'right'
      },
      {
        label: 'Mobile Emulator',
        activate: true
      }
    )
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      id: expect.any(String),
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: true
    })
    expect(mockStoreState.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it('does not create a split for background auto-attach', async () => {
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    stubCreatedSimulatorTab('group-1')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const { tabId, tab, sent, store } = await openThroughMain(() =>
        ensureSimulatorTab('wt-1', { placement: 'rightSplit', surfacePane: false })
      )
      expect(sent).toEqual([expect.objectContaining({ tabId, groupId: 'group-1' })])
      expect(sent[0]).not.toHaveProperty('split')
      expect(tab).toMatchObject({ label: 'Mobile Emulator', groupId: 'group-1' })
      expectNotSurfaced(store, tab!)
      return
    }
    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit', surfacePane: false })).toBe(
      createdSimulatorTabId()
    )

    expect(mockStoreState.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTabInSplit).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      id: expect.any(String),
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: false
    })
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).not.toHaveBeenCalled()
    expect(mockStoreState.setActiveTabType).not.toHaveBeenCalled()
  })

  it('stamps an inactive local simulator amid a same-id host collision', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.activeWorkspaceExecutionHostId = 'runtime:host-b'
    mockStoreState.allWorktrees.mockReturnValue([
      { id: 'wt-1', hostId: 'local' },
      { id: 'wt-1', hostId: 'runtime:host-b' }
    ])
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    stubCreatedSimulatorTab('group-1')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectBackgroundLocalOpen(true)
      return
    }
    expect(ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })).toBe(
      createdSimulatorTabId()
    )
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      id: expect.any(String),
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: false,
      executionHostId: 'local'
    })
  })

  it('does not reuse the sole known simulator when an explicit owner differs', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.allWorktrees.mockReturnValue([{ id: 'wt-1', hostId: 'runtime:host-b' }])
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'sim-remote',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          executionHostId: 'runtime:host-b',
          contentType: 'simulator'
        }
      ]
    }
    stubCreatedSimulatorTab('group-1')
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectBackgroundLocalOpen(false)
      return
    }
    expect(ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })).toBe(
      createdSimulatorTabId()
    )
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      id: expect.any(String),
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: false,
      executionHostId: 'local'
    })
  })

  it('reuses an explicitly owned simulator before its worktree row hydrates', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.allWorktrees.mockReturnValue([{ id: 'wt-1', hostId: 'runtime:host-b' }])
    mockStoreState.unifiedTabsByWorktree = {
      'wt-1': [
        {
          id: 'sim-local',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          executionHostId: 'local',
          contentType: 'simulator'
        }
      ]
    }
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })).toBe(
      'sim-local'
    )
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })

  it('does not create or focus a simulator tab when disabled in settings', async () => {
    mockStoreState.settings = { mobileEmulatorEnabled: false }
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBeNull()

    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })
})
