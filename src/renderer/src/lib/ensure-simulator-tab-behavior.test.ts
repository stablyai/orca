import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeWorktreeId: 'wt-1',
  activateTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  createUnifiedTab: vi.fn(),
  createUnifiedTabInSplit: vi.fn(),
  dropUnifiedTab: vi.fn(),
  focusGroup: vi.fn(),
  groupsByWorktree: {} as Record<string, { id: string }[]>,
  layoutByWorktree: {} as Record<string, unknown>,
  settings: { mobileEmulatorEnabled: true },
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  unifiedTabsByWorktree: {} as Record<
    string,
    { id: string; groupId: string; contentType: string; label?: string }[]
  >
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

describe('ensureSimulatorTab', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Macintosh' }
    })
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.activeWorktreeId = 'wt-1'
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
    mockStoreState.focusGroup.mockReset()
    mockStoreState.setActiveTab.mockReset()
    mockStoreState.setActiveTabType.mockReset()
    vi.resetModules()
  })

  it('activates an existing simulator tab through unified tab state', async () => {
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBe('sim-1')

    expect(mockStoreState.activateTab).toHaveBeenCalledWith('sim-1')
    expect(mockStoreState.setActiveTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('simulator')
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
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-2',
      groupId: 'group-2',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit' })).toBe('sim-2')

    expect(mockStoreState.createUnifiedTabInSplit).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      label: 'Mobile Emulator',
      targetGroupId: 'group-2',
      activate: true
    })
    expect(mockStoreState.activateTab).toHaveBeenCalledWith('sim-2')
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mockStoreState.setActiveTabType).toHaveBeenCalledWith('simulator')
  })

  it('falls back to the source group when atomic right split creation fails', async () => {
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.createUnifiedTabInSplit.mockReturnValue(null)
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-3',
      groupId: 'group-1',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit' })).toBe('sim-3')

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
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: true
    })
    expect(mockStoreState.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
  })

  it('does not create a split for background auto-attach', async () => {
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-4',
      groupId: 'group-1',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { placement: 'rightSplit', surfacePane: false })).toBe(
      'sim-4'
    )

    expect(mockStoreState.dropUnifiedTab).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTabInSplit).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
      label: 'Mobile Emulator',
      targetGroupId: 'group-1',
      activate: false
    })
    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.focusGroup).not.toHaveBeenCalled()
    expect(mockStoreState.setActiveTabType).not.toHaveBeenCalled()
  })

  it('does not create or focus a simulator tab when disabled in settings', async () => {
    mockStoreState.settings = { mobileEmulatorEnabled: false }
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBeNull()

    expect(mockStoreState.activateTab).not.toHaveBeenCalled()
    expect(mockStoreState.createUnifiedTab).not.toHaveBeenCalled()
  })
})
