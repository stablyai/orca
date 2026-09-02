import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import type { SshProviderEpoch } from '../../../../shared/ssh-types'
import type { DirectSshPaneRetryAttemptId } from './direct-ssh-terminal-recovery'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('creates a root tab group when the first terminal opens in a worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const terminal = store.getState().createTab(wt)
    const state = store.getState()
    const groups = state.groupsByWorktree[wt] ?? []
    const unifiedTabs = state.unifiedTabsByWorktree[wt] ?? []

    expect(groups).toHaveLength(1)
    expect(state.activeGroupIdByWorktree[wt]).toBe(groups[0].id)
    expect(state.layoutByWorktree[wt]).toEqual({ type: 'leaf', groupId: groups[0].id })
    expect(unifiedTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminal.id,
          entityId: terminal.id,
          worktreeId: wt,
          groupId: groups[0].id,
          contentType: 'terminal'
        })
      ])
    )
    expect(groups[0].activeTabId).toBe(terminal.id)
    expect(groups[0].tabOrder).toEqual([terminal.id])
  })

  it('moves live PTY ownership when detaching a primary pane to a tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const sourceTabId = 'tab-source'
    const targetTabId = 'tab-target'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: sourceTabId, worktreeId: wt, ptyId: 'pty-detached' }),
          makeTab({ id: targetTabId, worktreeId: wt, ptyId: null })
        ]
      },
      ptyIdsByTabId: {
        [sourceTabId]: ['pty-detached', 'pty-survivor'],
        [targetTabId]: ['pty-detached']
      },
      lastKnownRelayPtyIdByTabId: {
        [sourceTabId]: 'pty-detached',
        [targetTabId]: 'pty-detached'
      }
    })

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: '11111111-1111-4111-8111-111111111111',
      detachedPtyId: 'pty-detached',
      sourceLayout: {
        root: { type: 'leaf', leafId: 'survivor-leaf' },
        activeLeafId: 'survivor-leaf',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'survivor-leaf': 'pty-survivor' }
      },
      sourceTabId,
      targetTabId
    })

    const state = store.getState()
    expect(state.ptyIdsByTabId[sourceTabId]).toEqual(['pty-survivor'])
    expect(state.ptyIdsByTabId[targetTabId]).toEqual(['pty-detached'])
    expect(state.lastKnownRelayPtyIdByTabId[sourceTabId]).toBe('pty-survivor')
    expect(state.lastKnownRelayPtyIdByTabId[targetTabId]).toBe('pty-detached')
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === sourceTabId)?.ptyId).toBe(
      'pty-survivor'
    )
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === targetTabId)?.ptyId).toBe(
      'pty-detached'
    )
  })

  it('moves current direct SSH binding evidence when detaching a live pane', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const sourceTabId = 'tab-source'
    const targetTabId = 'tab-target'
    const authority = {
      targetId: 'target-a',
      providerEpoch: 'epoch-a' as SshProviderEpoch,
      connectionGeneration: 1
    }
    const detachedPtyId = 'ssh:target-a@@pty-detached'
    seedStore(store, {
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: sourceTabId, worktreeId: wt, ptyId: detachedPtyId }),
          makeTab({ id: targetTabId, worktreeId: wt, ptyId: null })
        ]
      },
      ptyIdsByTabId: { [sourceTabId]: [detachedPtyId], [targetTabId]: [] },
      directSshLivePtyBindingByTabId: {
        [sourceTabId]: {
          attemptId: 'live-detach' as DirectSshPaneRetryAttemptId,
          authority,
          tabGeneration: 0,
          ptyId: detachedPtyId
        }
      },
      directSshPaneRetryHistoryByTabId: {
        [sourceTabId]: { authority, attemptedAt: [1] }
      },
      sshConnectionStates: new Map([
        [
          authority.targetId,
          {
            targetId: authority.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: authority.providerEpoch,
            connectionGeneration: authority.connectionGeneration
          }
        ]
      ])
    })

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: '11111111-1111-4111-8111-111111111111',
      detachedPtyId,
      sourceLayout: makeLayout(),
      sourceTabId,
      targetTabId
    })

    const state = store.getState()
    expect(state.directSshPaneRetryByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshLivePtyBindingByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshPaneRetryHistoryByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshLivePtyBindingByTabId[targetTabId]).toEqual({
      attemptId: 'live-detach',
      authority,
      tabGeneration: 0,
      ptyId: detachedPtyId
    })
    expect(state.directSshPaneRetryHistoryByTabId[targetTabId]).toEqual({
      authority,
      attemptedAt: [1]
    })
  })

  it('rearms a current pending SSH detach as live destination evidence', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const sourceTabId = 'tab-source'
    const targetTabId = 'tab-target'
    const authority = {
      targetId: 'target-a',
      providerEpoch: 'epoch-a' as SshProviderEpoch,
      connectionGeneration: 1
    }
    const detachedPtyId = 'ssh:target-a@@pty-detached'
    seedStore(store, {
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: sourceTabId, worktreeId: wt, ptyId: detachedPtyId, generation: 2 }),
          makeTab({ id: targetTabId, worktreeId: wt, ptyId: null })
        ]
      },
      ptyIdsByTabId: { [sourceTabId]: [detachedPtyId], [targetTabId]: [] },
      directSshPaneRetryByTabId: {
        [sourceTabId]: {
          attemptId: 'pending-detach' as DirectSshPaneRetryAttemptId,
          authority,
          tabGeneration: 2,
          startedAt: 1
        }
      },
      sshConnectionStates: new Map([
        [
          authority.targetId,
          {
            targetId: authority.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: authority.providerEpoch,
            connectionGeneration: authority.connectionGeneration
          }
        ]
      ])
    })

    store.getState().syncPaneDetachPtyOwnership({
      detachedLeafId: '11111111-1111-4111-8111-111111111111',
      detachedPtyId,
      sourceLayout: makeLayout(),
      sourceTabId,
      targetTabId
    })

    const state = store.getState()
    expect(state.directSshPaneRetryByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshLivePtyBindingByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshPaneRetryHistoryByTabId[sourceTabId]).toBeUndefined()
    expect(state.directSshLivePtyBindingByTabId[targetTabId]).toEqual({
      attemptId: 'pending-detach',
      authority,
      tabGeneration: 0,
      ptyId: detachedPtyId
    })
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === targetTabId)?.ptyId).toBe(
      detachedPtyId
    )
  })

  // Regression for #9911: a split SSH tab's single relay slot points at the
  // last-bound pane; when it exits, clearTabPtyId must promote a surviving pane
  // instead of clearing, or a later relay-drop bulk-clear leaves the survivor
  // visible only in the layout leaf map and the orphan sweep deletes the live tab.
  it('promotes a surviving pane into the relay slot so a split tab is not orphaned after a relay drop', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const tabId = 'tab-split'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: tabId, worktreeId: wt, ptyId: 'pty-B' })] },
      ptyIdsByTabId: { [tabId]: ['pty-A', 'pty-B'] },
      // Newest-bound pane B owns the single relay slot.
      lastKnownRelayPtyIdByTabId: { [tabId]: 'pty-B' },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-A', 'leaf-b': 'pty-B' }
        }
      },
      // The transiently-absent unified entry is the condition #9911 recovers from.
      unifiedTabsByWorktree: { [wt]: [] }
    })

    // Pane B (the relay-slot owner) exits: the slot must fall back to survivor A.
    store.getState().clearTabPtyId(tabId, 'pty-B')
    expect(store.getState().ptyIdsByTabId[tabId]).toEqual(['pty-A'])
    expect(store.getState().lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')

    // Relay drop bulk-clears the row + live index but preserves the relay slot.
    store.getState().clearTabPtyId(tabId)
    const state = store.getState()
    expect(state.ptyIdsByTabId[tabId]).toEqual([])
    expect(state.tabsByWorktree[wt][0].ptyId).toBeNull()
    expect(state.lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')
    // Survivor A is still reconnectable, so the sweep must not delete the tab.
    expect(getOrphanTerminalIds(state, wt)).not.toContain(tabId)
  })

  it('stores trimmed quick command labels on terminal and unified tabs', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const labeled = store
      .getState()
      .createTab(wt, undefined, undefined, { quickCommandLabel: '  Run tests  ' })
    const unlabeled = store
      .getState()
      .createTab(wt, undefined, undefined, { quickCommandLabel: '   ' })
    const state = store.getState()

    expect(state.tabsByWorktree[wt].find((tab) => tab.id === labeled.id)?.quickCommandLabel).toBe(
      'Run tests'
    )
    expect(
      state.unifiedTabsByWorktree[wt].find((tab) => tab.entityId === labeled.id)?.quickCommandLabel
    ).toBe('Run tests')
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === unlabeled.id)).not.toHaveProperty(
      'quickCommandLabel'
    )
  })

  it('stores terminal startup cwd exactly and omits empty values', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const nested = store
      .getState()
      .createTab(wt, undefined, undefined, { startupCwd: '/path/wt1/packages/app ' })
    const empty = store.getState().createTab(wt, undefined, undefined, { startupCwd: '' })
    const state = store.getState()

    expect(state.tabsByWorktree[wt].find((tab) => tab.id === nested.id)?.startupCwd).toBe(
      '/path/wt1/packages/app '
    )
    expect(state.tabsByWorktree[wt].find((tab) => tab.id === empty.id)).not.toHaveProperty(
      'startupCwd'
    )
  })

  it('stamps the Windows default shell onto new terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::/path/wt1'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'cmd.exe' },
        worktreesByRepo: {
          repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt)
      expect(terminal.shellOverride).toBe('cmd.exe')

      store.setState({
        settings: { ...store.getState().settings!, terminalWindowsShell: 'powershell.exe' }
      })
      expect(store.getState().tabsByWorktree[wt][0].shellOverride).toBe('cmd.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('stamps host shell metadata when project runtime overrides stale WSL defaults', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::C:\\repo'

      seedStore(store, {
        settings: {
          ...getDefaultSettings('/tmp'),
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        },
        projects: [
          {
            id: 'project-1',
            displayName: 'Project',
            badgeColor: '#000',
            sourceRepoIds: ['repo1'],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              projectId: 'project-1',
              path: 'C:\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'wsl.exe')
      expect(terminal.shellOverride).toBe('powershell.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('stamps WSL shell metadata when project runtime overrides host defaults', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::C:\\repo'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' },
        projects: [
          {
            id: 'project-1',
            displayName: 'Project',
            badgeColor: '#000',
            sourceRepoIds: ['repo1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              projectId: 'project-1',
              path: 'C:\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBe('wsl.exe')

      const hostTerminal = store
        .getState()
        .createTab(wt, undefined, 'powershell.exe', { forceHostRuntime: true })
      expect(hostTerminal).toMatchObject({
        shellOverride: 'powershell.exe',
        forceHostRuntime: true
      })
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('uses WSL as the default shell for WSL worktree terminals on Windows', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'repo1::/wsl/path'

      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' },
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: wt,
              repoId: 'repo1',
              path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
            })
          ]
        }
      })

      const terminal = store.getState().createTab(wt)
      expect(terminal.shellOverride).toBe('wsl.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('does not stamp local Windows shell icons onto SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('preserves explicit Windows shell selections for Windows SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              remotePlatform: 'win32'
            }
          ]
        ]),
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBe('cmd.exe')
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('drops explicit Windows shell selections for non-Windows SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              remotePlatform: 'linux'
            }
          ]
        ]),
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'wsl.exe' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'cmd.exe')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })

  it('does not offer Git Bash as a local shell override for SSH terminal tabs', () => {
    const originalNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      configurable: true
    })
    try {
      const store = createTestStore()
      const wt = 'remote-repo::/path/wt1'

      seedStore(store, {
        repos: [
          {
            id: 'remote-repo',
            path: '/remote/repo',
            displayName: 'Remote Repo',
            badgeColor: '#000',
            addedAt: 0,
            connectionId: 'ssh-1'
          }
        ],
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'git-bash' },
        worktreesByRepo: {
          'remote-repo': [makeWorktree({ id: wt, repoId: 'remote-repo', path: '/path/wt1' })]
        }
      })

      const terminal = store.getState().createTab(wt, undefined, 'git-bash')
      expect(terminal.shellOverride).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true
      })
    }
  })
})
