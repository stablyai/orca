import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  retireWindowTerminalTabsAndConfirmClose,
  type WindowTerminalCloseRetirementDependencies
} from './terminal-window-close-retirement'

type TestState = ReturnType<WindowTerminalCloseRetirementDependencies['getState']>

function makeTab(id: string, worktreeId: string, ptyId: string) {
  return {
    id,
    worktreeId,
    ptyId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeState(
  tabsByWorktree: Record<string, ReturnType<typeof makeTab>[]>,
  overrides: Record<string, unknown> = {}
): TestState {
  const worktreeIds = Object.keys(tabsByWorktree).filter((id) => !id.startsWith('folder:'))
  return {
    activeWorktreeId: Object.keys(tabsByWorktree)[0] ?? null,
    tabsByWorktree,
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: Object.fromEntries(
      Object.values(tabsByWorktree)
        .flat()
        .map((tab) => [tab.id, [tab.ptyId]])
    ),
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    repos: worktreeIds.map((id) => ({
      id: `repo-${id}`,
      connectionId: null,
      executionHostId: 'local'
    })),
    worktreesByRepo: Object.fromEntries(
      worktreeIds.map((id) => [`repo-${id}`, [{ id, repoId: `repo-${id}`, hostId: 'local' }]])
    ),
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [],
    settings: { activeRuntimeEnvironmentId: null },
    ...overrides
  } as unknown as TestState
}

function removeTab(state: TestState, tabId: string): void {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    state.tabsByWorktree[worktreeId] = tabs.filter((tab) => tab.id !== tabId)
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    state.unifiedTabsByWorktree[worktreeId] = tabs.filter(
      (tab) => tab.contentType !== 'terminal' || tab.entityId !== tabId
    )
  }
}

function makeDependencies(
  state: TestState,
  overrides: Partial<WindowTerminalCloseRetirementDependencies> = {}
): WindowTerminalCloseRetirementDependencies {
  return {
    getState: () => state,
    getWindowSessionState: async () => ({
      activeRepoId: null,
      activeWorktreeId: state.activeWorktreeId,
      activeTabId: state.activeTabId,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      unifiedTabs: state.unifiedTabsByWorktree
    }),
    listOwnedProviderPtyIds: async () => [],
    closeTab: (tabId) => removeTab(state, tabId),
    persistRetiredSessionTabs: () => Promise.resolve(),
    clearWindowCloseAuthority: () => Promise.resolve(),
    dispatchBeforeUnload: () => true,
    awaitCheckpoint: () => Promise.resolve(),
    resetCheckpointAttempt: vi.fn(),
    confirmWindowClose: vi.fn(),
    ...overrides
  }
}

describe('terminal window close retirement', () => {
  it('wires user close through retirement while App quit keeps the detach path', () => {
    const source = readFileSync(new URL('../Terminal.tsx', import.meta.url), 'utf8')

    expect(source).toContain("from './terminal/terminal-window-close-retirement'")
    expect(source).toContain(
      'void retireWindowTerminalTabsAndConfirmClose(undefined, closeFencedPtyIds)'
    )
    expect(source).toContain('confirmNativeWindowClose(isQuitting)')
  })

  it('deletes this renderer local tabs, checkpoints the final snapshot, then confirms', async () => {
    const state = makeState(
      { 'wt-secondary': [makeTab('secondary-tab', 'wt-secondary', 'secondary-pty')] },
      {
        repos: [{ id: 'repo-secondary', connectionId: null, executionHostId: 'local' }],
        worktreesByRepo: {
          'repo-secondary': [{ id: 'wt-secondary', repoId: 'repo-secondary', hostId: 'local' }]
        }
      }
    )
    const controlWindowPtys = new Set(['control-pty'])
    const events: string[] = []
    let releaseCheckpoint: () => void = () => {}
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve
    })
    const deps = makeDependencies(state, {
      closeTab: (tabId, options) => {
        events.push(`close:${options.precomputedRetirementPlan.localOrSshPtyIds.join(',')}`)
        removeTab(state, tabId)
        events.push(`deleted:${state.tabsByWorktree['wt-secondary'].length}`)
      },
      dispatchBeforeUnload: () => {
        events.push(`checkpoint:${state.tabsByWorktree['wt-secondary'].length}`)
        return true
      },
      awaitCheckpoint: () => checkpoint,
      confirmWindowClose: () => events.push('confirm')
    })

    const close = retireWindowTerminalTabsAndConfirmClose(deps)

    await vi.waitFor(() => {
      expect(events).toEqual(['close:secondary-pty', 'deleted:0', 'checkpoint:0'])
    })
    expect(controlWindowPtys).toEqual(new Set(['control-pty']))
    releaseCheckpoint()
    await expect(close).resolves.toBe('confirmed')
    expect(events).toEqual(['close:secondary-pty', 'deleted:0', 'checkpoint:0', 'confirm'])
  })

  it('retires tabs from this window durable session when its renderer store is empty', async () => {
    const state = makeState(
      {},
      {
        repos: [{ id: 'repo-secondary', connectionId: null, executionHostId: 'local' }],
        worktreesByRepo: {
          'repo-secondary': [{ id: 'wt-secondary', repoId: 'repo-secondary', hostId: 'local' }]
        }
      }
    )
    const routed: string[] = []
    const deps = {
      ...makeDependencies(state, {
        closeTab: (_tabId, options) => {
          routed.push(...options.precomputedRetirementPlan.localOrSshPtyIds)
        }
      }),
      getWindowSessionState: async () => ({
        activeRepoId: 'repo-secondary',
        activeWorktreeId: 'wt-secondary',
        activeTabId: 'secondary-tab',
        tabsByWorktree: {
          'wt-secondary': [makeTab('secondary-tab', 'wt-secondary', 'secondary-pty')]
        },
        terminalLayoutsByTabId: {}
      })
    }

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('confirmed')

    expect(routed).toEqual(['secondary-pty'])
  })

  it('retires renderer-owned layout backing after its durable tab row is lost', async () => {
    const state = makeState({})
    const events: string[] = []
    let durableLayoutPresent = true
    const deps = makeDependencies(state, {
      listOwnedProviderPtyIds: async () => ['secondary-pty'],
      getWindowSessionState: async () => ({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {
          'secondary-tab': {
            root: { type: 'leaf', leafId: 'leaf-1' },
            activeLeafId: 'leaf-1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-1': 'secondary-pty' }
          }
        }
      }),
      closeTab: (_tabId, options) => {
        events.push(`close:${options.precomputedRetirementPlan.localOrSshPtyIds.join(',')}`)
      },
      persistRetiredSessionTabs: async (plans) => {
        expect(plans).toHaveLength(1)
        durableLayoutPresent = false
        events.push(`persist:${durableLayoutPresent}`)
      },
      dispatchBeforeUnload: () => {
        events.push(`checkpoint:${durableLayoutPresent}`)
        return true
      },
      confirmWindowClose: () => events.push('confirm')
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('confirmed')

    expect(events).toEqual(['close:secondary-pty', 'persist:false', 'checkpoint:false', 'confirm'])
  })

  it('uses exact close-fenced PTY ids supplied by main after renderer ownership is released', async () => {
    const state = makeState(
      {},
      {
        repos: [{ id: 'repo-secondary', connectionId: null, executionHostId: 'local' }],
        worktreesByRepo: {
          'repo-secondary': [{ id: 'wt-secondary', repoId: 'repo-secondary', hostId: 'local' }]
        }
      }
    )
    const routed: string[] = []
    const deps = makeDependencies(state, {
      getWindowSessionState: async () => ({
        activeRepoId: null,
        activeWorktreeId: 'wt-secondary',
        activeTabId: 'secondary-tab',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {
          'secondary-tab': {
            root: { type: 'leaf', leafId: 'leaf-secondary' },
            activeLeafId: 'leaf-secondary',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-secondary': 'secondary-pty' }
          }
        },
        unifiedTabs: {
          'wt-secondary': [
            {
              id: 'terminal:secondary-tab',
              contentType: 'terminal',
              entityId: 'secondary-tab',
              worktreeId: 'wt-secondary',
              groupId: 'group-secondary',
              label: 'Terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        }
      }),
      closeTab: (_tabId, options) => {
        routed.push(...options.precomputedRetirementPlan.localOrSshPtyIds)
      }
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps, ['secondary-pty'])).resolves.toBe(
      'confirmed'
    )

    expect(routed).toEqual(['secondary-pty'])
  })

  it('routes direct SSH tabs by their full connection-scoped PTY ids', async () => {
    const state = makeState(
      {
        'wt-a': [makeTab('tab-a', 'wt-a', 'ssh:connection-a@@pty-a')],
        'wt-b': [makeTab('tab-b', 'wt-b', 'ssh:connection-b@@pty-b')]
      },
      {
        repos: [
          { id: 'repo-a', connectionId: 'connection-a', executionHostId: 'ssh:connection-a' },
          { id: 'repo-b', connectionId: 'connection-b', executionHostId: 'ssh:connection-b' }
        ],
        worktreesByRepo: {
          'repo-a': [{ id: 'wt-a', repoId: 'repo-a', hostId: 'ssh:connection-a' }],
          'repo-b': [{ id: 'wt-b', repoId: 'repo-b', hostId: 'ssh:connection-b' }]
        }
      }
    )
    const routed: string[] = []
    const deps = makeDependencies(state, {
      closeTab: (tabId, options) => {
        routed.push(...options.precomputedRetirementPlan.localOrSshPtyIds)
        removeTab(state, tabId)
      }
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('confirmed')

    expect(routed).toEqual(['ssh:connection-a@@pty-a', 'ssh:connection-b@@pty-b'])
  })

  it('routes runtime tabs to their exact environment and handle', async () => {
    const state = makeState({
      'wt-a': [makeTab('tab-a', 'wt-a', 'remote:environment-a@@handle-a')],
      'wt-b': [makeTab('tab-b', 'wt-b', 'remote:environment-b@@handle-b')]
    })
    const routed: { environmentId: string | null; handle: string }[] = []
    const deps = makeDependencies(state, {
      closeTab: (tabId, options) => {
        routed.push(...options.precomputedRetirementPlan.runtimeTerminals)
        removeTab(state, tabId)
      }
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('confirmed')

    expect(routed).toEqual([
      expect.objectContaining({ environmentId: 'environment-a', handle: 'handle-a' }),
      expect.objectContaining({ environmentId: 'environment-b', handle: 'handle-b' })
    ])
  })

  it('routes mixed folder tabs from each PTY owner instead of the folder key', async () => {
    const worktreeId = 'folder:folder-1'
    const state = makeState(
      {
        [worktreeId]: [
          makeTab('local-tab', worktreeId, 'local-pty'),
          makeTab('runtime-tab', worktreeId, 'remote:environment-a@@handle-a')
        ]
      },
      {
        folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group-1', connectionId: null }],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null }]
      }
    )
    const routed: unknown[] = []
    const deps = makeDependencies(state, {
      closeTab: (tabId, options) => {
        routed.push({
          local: options.precomputedRetirementPlan.localOrSshPtyIds,
          runtime: options.precomputedRetirementPlan.runtimeTerminals
        })
        removeTab(state, tabId)
      }
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('confirmed')

    expect(routed).toEqual([
      { local: ['local-pty'], runtime: [] },
      {
        local: [],
        runtime: [expect.objectContaining({ environmentId: 'environment-a', handle: 'handle-a' })]
      }
    ])
  })

  it('keeps the window open when a tab close does not delete its target', async () => {
    const state = makeState({ 'wt-1': [makeTab('tab-1', 'wt-1', 'pty-1')] })
    const dispatchBeforeUnload = vi.fn(() => true)
    const confirmWindowClose = vi.fn()
    const deps = makeDependencies(state, {
      closeTab: vi.fn(),
      dispatchBeforeUnload,
      confirmWindowClose
    })

    await expect(retireWindowTerminalTabsAndConfirmClose(deps)).resolves.toBe('blocked')

    expect(dispatchBeforeUnload).not.toHaveBeenCalled()
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('preflights every route before deleting any tab', async () => {
    const state = makeState(
      {
        'wt-routable': [makeTab('routable-tab', 'wt-routable', 'pty-1')],
        'wt-unresolved': [makeTab('unresolved-tab', 'wt-unresolved', 'pty-2')]
      },
      {
        repos: [{ id: 'repo-routable', connectionId: null, executionHostId: 'local' }],
        worktreesByRepo: {
          'repo-routable': [{ id: 'wt-routable', repoId: 'repo-routable', hostId: 'local' }]
        }
      }
    )
    const closeTab = vi.fn((tabId: string) => removeTab(state, tabId))
    const confirmWindowClose = vi.fn()

    await expect(
      retireWindowTerminalTabsAndConfirmClose(
        makeDependencies(state, { closeTab, confirmWindowClose })
      )
    ).resolves.toBe('blocked')

    expect(closeTab).not.toHaveBeenCalled()
    expect(state.tabsByWorktree['wt-routable']).toHaveLength(1)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('does not confirm when unload is canceled or checkpoint persistence fails', async () => {
    const canceledState = makeState({ 'wt-1': [makeTab('tab-1', 'wt-1', 'pty-1')] })
    const canceledConfirm = vi.fn()
    await expect(
      retireWindowTerminalTabsAndConfirmClose(
        makeDependencies(canceledState, {
          dispatchBeforeUnload: () => false,
          confirmWindowClose: canceledConfirm
        })
      )
    ).resolves.toBe('blocked')
    expect(canceledConfirm).not.toHaveBeenCalled()

    const failedState = makeState({ 'wt-2': [makeTab('tab-2', 'wt-2', 'pty-2')] })
    const failedConfirm = vi.fn()
    const resetCheckpointAttempt = vi.fn()
    await expect(
      retireWindowTerminalTabsAndConfirmClose(
        makeDependencies(failedState, {
          awaitCheckpoint: () => Promise.reject(new Error('disk unavailable')),
          resetCheckpointAttempt,
          confirmWindowClose: failedConfirm
        })
      )
    ).resolves.toBe('blocked')
    expect(failedConfirm).not.toHaveBeenCalled()
    expect(resetCheckpointAttempt).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the sender-scoped durable session cannot be read', async () => {
    const state = makeState({})
    const closeTab = vi.fn()
    const dispatchBeforeUnload = vi.fn(() => true)
    const confirmWindowClose = vi.fn()

    await expect(
      retireWindowTerminalTabsAndConfirmClose(
        makeDependencies(state, {
          getWindowSessionState: () => Promise.reject(new Error('session unavailable')),
          closeTab,
          dispatchBeforeUnload,
          confirmWindowClose
        })
      )
    ).resolves.toBe('blocked')

    expect(closeTab).not.toHaveBeenCalled()
    expect(dispatchBeforeUnload).not.toHaveBeenCalled()
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('coalesces re-entry and never kills the same PTY twice', async () => {
    const state = makeState({ 'wt-1': [makeTab('tab-1', 'wt-1', 'pty-1')] })
    let releaseCheckpoint: () => void = () => {}
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve
    })
    const closeTab = vi.fn((tabId: string) => removeTab(state, tabId))
    const confirmWindowClose = vi.fn()
    const deps = makeDependencies(state, {
      closeTab,
      awaitCheckpoint: () => checkpoint,
      confirmWindowClose
    })

    const first = retireWindowTerminalTabsAndConfirmClose(deps)
    const second = retireWindowTerminalTabsAndConfirmClose(deps)
    releaseCheckpoint()

    await expect(Promise.all([first, second])).resolves.toEqual(['confirmed', 'confirmed'])
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('does not confirm if a new terminal appears while the checkpoint is pending', async () => {
    const state = makeState({ 'wt-1': [makeTab('tab-1', 'wt-1', 'pty-1')] })
    let releaseCheckpoint: () => void = () => {}
    let markCheckpointStarted: () => void = () => {}
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve
    })
    const checkpointStarted = new Promise<void>((resolve) => {
      markCheckpointStarted = resolve
    })
    const confirmWindowClose = vi.fn()
    const close = retireWindowTerminalTabsAndConfirmClose(
      makeDependencies(state, {
        awaitCheckpoint: () => {
          markCheckpointStarted()
          return checkpoint
        },
        confirmWindowClose
      })
    )
    await checkpointStarted
    state.tabsByWorktree['wt-1'].push(makeTab('new-tab', 'wt-1', 'new-pty'))
    releaseCheckpoint()

    await expect(close).resolves.toBe('blocked')
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})
