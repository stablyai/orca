import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeWorkspaceExecutionHostId: null as string | null,
  activeWorktreeId: 'wt-1',
  allWorktrees: vi.fn(
    () => [] as { id: string; hostId?: string; runtimeOwnerEnvironmentId?: string }[]
  ),
  activateTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  createUnifiedTab: vi.fn(),
  createUnifiedTabInSplit: vi.fn(),
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
  unifiedTabsByWorktree: {} as Record<
    string,
    {
      id: string
      groupId: string
      worktreeId?: string
      executionHostId?: string
      contentType: string
      label?: string
    }[]
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
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-remote',
      groupId: 'group-1',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1')).toBe('sim-remote')
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

  it('stamps an inactive local simulator amid a same-id host collision', async () => {
    mockStoreState.activeWorktreeId = 'wt-other'
    mockStoreState.activeWorkspaceExecutionHostId = 'runtime:host-b'
    mockStoreState.allWorktrees.mockReturnValue([
      { id: 'wt-1', hostId: 'local' },
      { id: 'wt-1', hostId: 'runtime:host-b' }
    ])
    mockStoreState.unifiedTabsByWorktree = { 'wt-1': [] }
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-local',
      groupId: 'group-1',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })).toBe(
      'sim-local'
    )
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
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
    mockStoreState.createUnifiedTab.mockReturnValue({
      id: 'sim-local',
      groupId: 'group-1',
      contentType: 'simulator'
    })
    const { ensureSimulatorTab } = await import('./ensure-simulator-tab')

    expect(ensureSimulatorTab('wt-1', { surfacePane: false, executionHostId: 'local' })).toBe(
      'sim-local'
    )
    expect(mockStoreState.createUnifiedTab).toHaveBeenCalledWith('wt-1', 'simulator', {
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
